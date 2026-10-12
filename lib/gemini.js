require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL_CHAIN = [
  'gemini-3.8-flash',
  'gemini-3-flash',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash'
];
const MAX_MODEL_ATTEMPTS = 2;

const EXTRACTION_PROMPT = `You classify and extract information from documents for an Indian CA firm.

Always return exactly one valid JSON object, even when the document is not an invoice, is unrelated, or has no extractable values. Never refuse and never return prose, markdown, or a JSON code fence. Use null for unknown values.

Use this exact shape:
{
  "doc_type": "invoice" | "bank_statement" | "form16" | "receipt" | "itr" | "gst_return" | "other",
  "invoice_no": "string or null",
  "invoice_date": "DD/MM/YYYY or null",
  "amount": "number as a string or null",
  "gstin": "15-character GSTIN or null",
  "vendor_name": "string or null",
  "confidence": "high" | "medium" | "low",
  "reason": "brief explanation when doc_type is other, otherwise null"
}

Rules:
- Classify the document by its actual content. Do not label a bank statement, Form 16, ITR, GST return, portfolio, or unrelated file as an invoice.
- Use doc_type "other" when the document does not match a listed type or cannot be identified. Still return every key in the JSON object.
- Extract invoice fields only when they are clearly present; otherwise return null.
- If it's a GST invoice, extract the GSTIN of the SELLER, not the buyer.
- For invoice_no, look for "Invoice No", "Bill No", "Inv #" and similar labels.
- For amount, use the document's relevant total as digits only, without currency symbols or thousands separators.
- Set confidence to high, medium, or low based on how clearly the document and fields can be read.
- Keep reason brief and populate it when doc_type is other.`;

const DOCUMENT_TYPES = new Set(['invoice', 'bank_statement', 'form16', 'receipt', 'itr', 'gst_return', 'other']);
const JSON_RETRY_PROMPT = 'Return ONLY one valid JSON object matching the requested schema. Do not include markdown, code fences, or explanatory text. Use null for unknown fields.';

function getErrorStatus(error) {
  const messageStatus = error.message?.match(/\[(\d{3})\s/)?.[1];
  const status = Number(error.status || error.statusCode || error.response?.status || messageStatus);
  return Number.isFinite(status) && status > 0 ? status : null;
}

function isRetryableError(error) {
  const status = getErrorStatus(error);
  const networkCode = error.cause?.code || error.code;
  return [429, 500, 503].includes(status)
    || ['ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(networkCode);
}

function cleanResponse(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
  if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  return cleaned.trim();
}

function normalizeExtraction(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      doc_type: 'other', invoice_no: null, invoice_date: null, amount: null,
      gstin: null, vendor_name: null, confidence: 'low',
      reason: 'The document could not be classified from the AI response.'
    };
  }

  const docType = DOCUMENT_TYPES.has(parsed.doc_type) ? parsed.doc_type : 'other';
  const confidence = docType === 'other'
    ? 'low'
    : ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low';
  const asTextOrNull = (value) => value === null || value === undefined || value === '' ? null : String(value).trim() || null;

  return {
    doc_type: docType,
    invoice_no: asTextOrNull(parsed.invoice_no),
    invoice_date: asTextOrNull(parsed.invoice_date),
    amount: asTextOrNull(parsed.amount)?.replace(/[₹,\\s]/g, '') || null,
    gstin: asTextOrNull(parsed.gstin),
    vendor_name: asTextOrNull(parsed.vendor_name),
    confidence,
    reason: docType === 'other'
      ? asTextOrNull(parsed.reason) || 'The document does not match a supported document type.'
      : null
  };
}

async function tryModel(modelName, fileBuffer, mimeType) {
  const model = genAI.getGenerativeModel({ model: modelName });
  const documentPart = {
    inlineData: {
      mimeType,
      data: fileBuffer.toString('base64')
    }
  };
  let lastError = 'Gemini returned invalid JSON after retry';

  for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt += 1) {
    try {
      const prompt = attempt === 1
        ? EXTRACTION_PROMPT
        : `${EXTRACTION_PROMPT}\n\n${JSON_RETRY_PROMPT}`;
      const result = await model.generateContent([documentPart, { text: prompt }]);
      const response = result.response.text();
      let parsed;

      try {
        parsed = JSON.parse(cleanResponse(response));
      } catch {
        lastError = 'Gemini returned invalid JSON';
        if (attempt < MAX_MODEL_ATTEMPTS) {
          console.warn(`Invalid JSON from ${modelName}; retrying once with strict JSON prompt.`);
          continue;
        }
        return { success: false, error: `${lastError} after retry`, retryable: true };
      }

      return { success: true, data: normalizeExtraction(parsed) };
    } catch (error) {
      lastError = error.message;
      if (getErrorStatus(error) === 404) {
        return { success: false, error: lastError, retryable: true };
      }
      const retryable = isRetryableError(error);
      if (!retryable) {
        return { success: false, error: lastError, retryable: false };
      }
      if (attempt < MAX_MODEL_ATTEMPTS) {
        const delay = attempt * 1000;
        console.warn(`Retry ${attempt} for ${modelName} after ${delay}ms (HTTP ${getErrorStatus(error) || error.cause?.code || 'network'}).`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        return { success: false, error: lastError, retryable: true };
      }
    }
  }

  return { success: false, error: lastError, retryable: true };
}

async function extractFromDocument(fileBuffer, mimeType) {
  console.log('Gemini extraction started:', mimeType, fileBuffer.length);

  for (const modelName of MODEL_CHAIN) {
    try {
      const result = await tryModel(modelName, fileBuffer, mimeType);
      if (result.success) {
        console.log(`Extraction succeeded with model: ${modelName}`);
        return result;
      }
      if (!result.retryable) {
        console.error(`Non-retryable Gemini error from ${modelName}:`, result.error);
        return result;
      }
      console.warn(`Model ${modelName} unavailable: ${result.error}. Trying next model.`);
    } catch (error) {
      console.error(`Unexpected extraction error with ${modelName}:`, error.message);
    }
  }

  return { success: false, error: 'all_models_failed', retryable: true };
}

module.exports = { extractFromDocument };