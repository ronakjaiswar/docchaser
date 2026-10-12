const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  const firmId = req.session.firmId;

  // Fetch clients
  const { data: clients, error } = await supabaseAdmin
    .from('clients')
    .select('*')
    .eq('firm_id', firmId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error(error);
    return res.render('dashboard', {
      firmName: req.session.firmName,
      clients: [],
      stats: { totalClients: 0, pending: 0, received: 0, totalDocuments: 0 }
    });
  }

  const { data: requests, error: requestsError } = await supabaseAdmin
    .from('requests')
    .select('id, client_id, status, created_at, documents(id, extraction_status)')
    .eq('firm_id', firmId)
    .order('created_at', { ascending: false });

  if (requestsError) {
    console.error('Dashboard request query error:', requestsError);
  }

  const latestByClient = new Map();
  let totalDocuments = 0;
  for (const request of requests || []) {
    const documents = request.documents || [];
    totalDocuments += documents.length;
    if (!latestByClient.has(request.client_id)) {
      latestByClient.set(request.client_id, { ...request, documents });
    }
  }

  const clientsWithStatus = (clients || []).map((client) => {
    const latest = latestByClient.get(client.id);
    return {
      ...client,
      status: latest ? latest.status : 'no_request',
      docCount: latest ? latest.documents.length : 0,
      aiExtracted: Boolean(latest?.documents.some((document) => document.extraction_status === 'completed'))
    };
  });

  const stats = {
    totalClients: clientsWithStatus.length,
    pending: clientsWithStatus.filter((client) => client.status === 'pending').length,
    received: clientsWithStatus.filter((client) => client.status === 'received').length,
    totalDocuments
  };

  res.render('dashboard', {
    firmName: req.session.firmName,
    clients: clientsWithStatus,
    stats
  });
});

router.post('/documents/:id/retry-extraction', requireAuth, async (req, res) => {
  try {
    const { data: doc, error: documentError } = await supabaseAdmin
      .from('documents')
      .select('id, file_name, file_url, requests!inner(firm_id)')
      .eq('id', req.params.id)
      .eq('requests.firm_id', req.session.firmId)
      .single();

    if (documentError || !doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const extension = doc.file_name.split('.').pop().toLowerCase();
    const mimeTypes = {
      pdf: 'application/pdf',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif',
      bmp: 'image/bmp'
    };
    const mimeType = mimeTypes[extension];
    if (!mimeType) {
      return res.status(415).json({ error: 'AI retry supports PDF and image files only' });
    }

    const fileUrl = new URL(doc.file_url);
    const supabaseOrigin = new URL(process.env.SUPABASE_URL).origin;
    const storagePrefix = '/storage/v1/object/public/documents/';
    if (fileUrl.origin !== supabaseOrigin || !fileUrl.pathname.startsWith(storagePrefix)) {
      return res.status(404).json({ error: 'Document file not found' });
    }
    const objectPath = decodeURIComponent(fileUrl.pathname.slice(storagePrefix.length));
    if (!objectPath) {
      return res.status(404).json({ error: 'Document file not found' });
    }

    const { error: processingError } = await supabaseAdmin
      .from('documents')
      .update({ extraction_status: 'processing' })
      .eq('id', doc.id);
    if (processingError) {
      console.error('Could not mark document processing:', processingError);
      return res.status(500).json({ error: 'Could not start extraction retry' });
    }

    const { data: fileData, error: downloadError } = await supabaseAdmin.storage
      .from('documents')
      .download(objectPath);
    if (downloadError || !fileData) {
      console.error('Could not download document for retry:', downloadError);
      await supabaseAdmin.from('documents').update({ extraction_status: 'retry_pending' }).eq('id', doc.id);
      return res.status(502).json({ error: 'Could not retrieve the document for retry' });
    }

    const extraction = await extractFromDocument(Buffer.from(await fileData.arrayBuffer()), mimeType);
    if (extraction.success) {
      const { error: saveError } = await supabaseAdmin
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
        .eq('id', doc.id);

      if (saveError) {
        console.error('Could not save retried extraction:', saveError);
        await supabaseAdmin.from('documents').update({ extraction_status: 'retry_pending' }).eq('id', doc.id);
        return res.status(500).json({ error: 'Extraction succeeded but results could not be saved' });
      }
      return res.json({ success: true, data: extraction.data });
    }

    await supabaseAdmin.from('documents').update({ extraction_status: 'retry_pending' }).eq('id', doc.id);
    return res.json({ success: false, error: extraction.error || 'Extraction failed' });
  } catch (error) {
    console.error('Document extraction retry failed:', error);
    return res.status(500).json({ error: 'Extraction retry failed' });
  }
});

router.get('/documents/:id/download', requireAuth, async (req, res) => {
  try {
    const { data: doc, error } = await supabaseAdmin
      .from('documents')
      .select('id, file_name, file_url, requests!inner(firm_id)')
      .eq('id', req.params.id)
      .eq('requests.firm_id', req.session.firmId)
      .single();

    if (error || !doc) {
      return res.status(404).send('Document not found');
    }

    const fileUrl = new URL(doc.file_url);
    const supabaseOrigin = new URL(process.env.SUPABASE_URL).origin;
    const storagePrefix = '/storage/v1/object/public/documents/';
    if (fileUrl.origin !== supabaseOrigin || !fileUrl.pathname.startsWith(storagePrefix)) {
      return res.status(404).send('Document not found');
    }

    const objectPath = decodeURIComponent(fileUrl.pathname.slice(storagePrefix.length));
    if (!objectPath) {
      return res.status(404).send('Document not found');
    }

    const { data: fileData, error: downloadError } = await supabaseAdmin.storage
      .from('documents')
      .download(objectPath);

    if (downloadError || !fileData) {
      console.error('Document download error:', downloadError);
      return res.status(502).send('Download failed');
    }

    const buffer = Buffer.from(await fileData.arrayBuffer());
    const safeFileName = doc.file_name.replace(/[\r\n"\\]/g, '_');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFileName}"; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`);
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);
  } catch (downloadError) {
    console.error('Document download request failed:', downloadError);
    return res.status(500).send('Download failed');
  }
});

router.get('/clients/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const firmId = req.session.firmId;

  // Fetch client
  const { data: client, error: clientErr } = await supabaseAdmin
    .from('clients')
    .select('*')
    .eq('id', id)
    .eq('firm_id', firmId)
    .single();

  if (clientErr || !client) {
    return res.status(404).send('Client not found');
  }

  // Fetch requests with documents
  const { data: requests } = await supabaseAdmin
    .from('requests')
    .select('*, documents(*)')
    .eq('client_id', id)
    .order('created_at', { ascending: false });

  const documents = (requests || []).flatMap((request) => request.documents || []);
  const completedDocuments = documents.filter((document) => document.extraction_status === 'completed');
  const uniqueGstins = new Set(completedDocuments.map((document) => document.gstin?.trim().toUpperCase()).filter(Boolean));
  const totalAmount = completedDocuments.reduce((total, document) => {
    const amount = Number(String(document.amount || '').replace(/[^\d.-]/g, ''));
    return total + (Number.isFinite(amount) ? amount : 0);
  }, 0);

  res.render('client-detail', {
    firmName: req.session.firmName,
    client,
    requests: requests || [],
    insights: {
      documentsAnalyzed: completedDocuments.length,
      totalAmount: new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(totalAmount),
      uniqueGstins: uniqueGstins.size
    }
  });
});

module.exports = router;