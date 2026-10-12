const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');

// GET /clients/new
router.get('/new', requireAuth, (req, res) => {
  res.render('add-client', { error: null });
});

// POST /clients/new
router.post('/new', requireAuth, async (req, res) => {
  const { name, phone } = req.body;
  const firmId = req.session.firmId;

  if (!name || !phone) {
    return res.render('add-client', { error: 'All fields required' });
  }

  const { error } = await supabaseAdmin
    .from('clients')
    .insert({ firm_id: firmId, name, phone });

  if (error) {
    return res.render('add-client', { error: error.message });
  }

  res.redirect('/dashboard');
});

// POST /clients/:id/request — generate token + WhatsApp link
router.post('/:id/request', requireAuth, async (req, res) => {
  const clientId = req.params.id;
  const firmId = req.session.firmId;

  // Fetch client
  const { data: client, error: clientErr } = await supabaseAdmin
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .eq('firm_id', firmId)
    .single();

  if (clientErr || !client) {
    return res.status(404).json({ error: 'Client not found' });
  }

  // Check if pending request already exists
  const { data: existing } = await supabaseAdmin
    .from('requests')
    .select('*')
    .eq('client_id', clientId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1);

  let token;

  if (existing && existing.length > 0) {
    token = existing[0].token;
  } else {
    // Create new request
    token = crypto.randomUUID();
    const { error: reqErr } = await supabaseAdmin
      .from('requests')
      .insert({ client_id: clientId, firm_id: firmId, token, status: 'pending' });

    if (reqErr) {
      return res.status(500).json({ error: reqErr.message });
    }
  }

  // Build URLs
  const uploadUrl = `${req.protocol}://${req.get('host')}/u/${token}`;
  const message = `Hi ${client.name}, please upload your documents here:\n${uploadUrl}\n\n- ${req.session.firmName}`;
  const waLink = `https://wa.me/91${client.phone}?text=${encodeURIComponent(message)}`;

  res.json({ uploadUrl, waLink });
});
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');

const bulkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// GET /clients/import — upload page
router.get('/import', requireAuth, (req, res) => {
  res.render('import-clients', { error: null, preview: null, rawRows: null });
});

// POST /clients/import — parse file, show preview
router.post('/import', requireAuth, bulkUpload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.render('import-clients', { error: 'Please select a file', preview: null, rawRows: null });
  }

  const filename = req.file.originalname.toLowerCase();
  let rows = [];

  try {
    if (filename.endsWith('.csv')) {
      rows = parse(req.file.buffer.toString('utf-8'), {
        columns: true,
        skip_empty_lines: true,
        trim: true
      });
    } else if (filename.endsWith('.xlsx') || filename.endsWith('.xls')) {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    } else {
      return res.render('import-clients', {
        error: 'Only CSV or Excel files allowed',
        preview: null,
        rawRows: null
      });
    }
  } catch (err) {
    return res.render('import-clients', {
      error: 'Could not parse file: ' + err.message,
      preview: null,
      rawRows: null
    });
  }

  if (rows.length === 0) {
    return res.render('import-clients', {
      error: 'File is empty',
      preview: null,
      rawRows: null
    });
  }

  // Auto-detect columns
  const headers = Object.keys(rows[0]);
  const nameCol = headers.find(h => /name|client|party|customer/i.test(h));
  const phoneCol = headers.find(h => /phone|mobile|contact|whatsapp|number|no\.?/i.test(h));

  const preview = rows.slice(0, 10).map(row => ({
    name: nameCol ? String(row[nameCol]).trim() : '',
    phone: phoneCol ? String(row[phoneCol]).replace(/\D/g, '').slice(-10) : '',
    valid: !!(nameCol && phoneCol && row[nameCol] && row[phoneCol])
  }));

  // Store raw rows in session temporarily
  req.session.importData = {
    rows: rows,
    nameCol,
    phoneCol
  };

  res.render('import-clients', {
    error: null,
    preview,
    headers,
    nameCol,
    phoneCol,
    totalRows: rows.length
  });
});

// POST /clients/import/confirm — actually insert
router.post('/import/confirm', requireAuth, async (req, res) => {
  const data = req.session.importData;

  if (!data || !data.rows || !data.nameCol || !data.phoneCol) {
    return res.redirect('/clients/import');
  }

  const firmId = req.session.firmId;
  const inserts = [];
  const seenPhones = new Set();

  for (const row of data.rows) {
    const name = String(row[data.nameCol] || '').trim();
    const phone = String(row[data.phoneCol] || '').replace(/\D/g, '').slice(-10);

    if (!name || phone.length !== 10) continue;
    if (seenPhones.has(phone)) continue;

    seenPhones.add(phone);
    inserts.push({ firm_id: firmId, name, phone });
  }

  if (inserts.length > 0) {
    await supabaseAdmin.from('clients').insert(inserts);
  }

  req.session.importData = null;

  res.redirect('/dashboard?imported=' + inserts.length);
});



module.exports = router;