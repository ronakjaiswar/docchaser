const express = require('express');
const router = express.Router();
const multer = require('multer');
const { supabaseAdmin } = require('../lib/supabase');
const { extractFromDocument } = require('../lib/gemini');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// GET /u/:token
router.get('/:token', async (req, res) => {
  const { token } = req.params;

  const { data: request, error } = await supabaseAdmin
    .from('requests')
    .select('*, firms(name), documents(id, file_name, uploaded_at, extraction_status)')
    .eq('token', token)
    .single();

  if (error || !request) {
    return res.status(404).render('upload', {
      error: 'Invalid or expired link', firmName: null, token, documents: [], requestStatus: null,
      requestCreatedAt: null, success: false
    });
  }

  const firmName = request.firms?.name || 'CA Firm';
  const success = req.query.success === '1';
  const errorMessage = req.query.error === 'upload_failed' ? 'Files could not be saved. Please try again.' : null;

  res.render('upload', {
    error: errorMessage,
    firmName,
    token,
    success,
    documents: request.documents || [],
    requestStatus: request.status,
    requestCreatedAt: request.created_at
  });
});

// POST /u/:token/upload
router.post('/:token/upload', upload.array('documents', 10), async (req, res) => {
  const { token } = req.params;

  const { data: request, error } = await supabaseAdmin
    .from('requests')
    .select('*')
    .eq('token', token)
    .single();

  if (error || !request) {
    return res.status(404).render('upload', {
      error: 'Invalid link', firmName: null, token, documents: [], requestStatus: null,
      requestCreatedAt: null, success: false
    });
  }

  if (!req.files || req.files.length === 0) {
    const { data: firm } = await supabaseAdmin.from('firms').select('name').eq('id', request.firm_id).single();
    return res.status(400).render('upload', {
      error: 'Please select at least one file', firmName: firm?.name || 'CA Firm', token,
      documents: [], requestStatus: request.status, requestCreatedAt: request.created_at, success: false
    });
  }

  let savedDocumentCount = 0;
  for (const file of req.files) {
    const filePath = `${token}/${Date.now()}-${file.originalname}`;

    // 1. Upload to Supabase Storage
    const { error: uploadErr } = await supabaseAdmin.storage
      .from('documents')
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false
      });

    if (uploadErr) {
      console.error('Upload error:', uploadErr);
      continue;
    }

    const { data: urlData } = supabaseAdmin.storage
      .from('documents')
      .getPublicUrl(filePath);

    // 2. Insert initial row (without extraction yet)
    const { data: docRow, error: documentInsertError } = await supabaseAdmin
      .from('documents')
      .insert({
        request_id: request.id,
        file_name: file.originalname,
        file_url: urlData.publicUrl,
        extraction_status: 'processing'
      })
      .select()
      .single();

    if (documentInsertError || !docRow) {
      console.error('Document record insert error:', documentInsertError || 'No document row returned');
      continue;
    }
    savedDocumentCount += 1;

    // 3. AI Extraction (only for PDF and images)
    if (file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/')) {
      const extraction = await extractFromDocument(file.buffer, file.mimetype);

      if (extraction.success) {
        const { error: extractionUpdateError } = await supabaseAdmin
          .from('documents')
          .update({
            doc_type: extraction.data.doc_type,
            invoice_no: extraction.data.invoice_no,
            invoice_date: extraction.data.invoice_date,
            amount: extraction.data.amount,
            gstin: extraction.data.gstin,
            vendor_name: extraction.data.vendor_name,
            extraction_status: 'completed',
            extraction_raw: extraction.data
          })
          .eq('id', docRow.id);
        if (extractionUpdateError) console.error('Document extraction save error:', extractionUpdateError);
      } else {
        console.error(`AI extraction failed for ${file.originalname}:`, extraction.error);
        const { error: extractionUpdateError } = await supabaseAdmin
          .from('documents')
          .update({ extraction_status: 'retry_pending' })
          .eq('id', docRow.id);
        if (extractionUpdateError) console.error('Document extraction failure status update error:', extractionUpdateError);
      }
    } else {
      const { error: extractionUpdateError } = await supabaseAdmin
        .from('documents')
        .update({ extraction_status: 'skipped' })
        .eq('id', docRow.id);
      if (extractionUpdateError) console.error('Document skipped status update error:', extractionUpdateError);
    }
  }

  if (savedDocumentCount > 0) {
    const { error: requestUpdateError } = await supabaseAdmin
      .from('requests')
      .update({ status: 'received' })
      .eq('id', request.id);
    if (requestUpdateError) console.error('Request received status update error:', requestUpdateError);
    return res.redirect(`/u/${token}?success=1`);
  }

  res.redirect(`/u/${token}?error=upload_failed`);
});

module.exports = router;