const express = require('express');
const router = express.Router();
const { supabase, supabaseAdmin } = require('../lib/supabase');
const { redirectIfLoggedIn } = require('../middleware/auth');

function authErrorMessage(error) {
  const details = `${error?.message || ''} ${error?.details || ''} ${error?.cause?.message || ''}`;
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(details)) {
    return 'Supabase se connection nahi ho pa raha. Internet aur Supabase project URL check karke dobara try karein.';
  }
  return error?.message || 'Request complete nahi ho saka. Dobara try karein.';
}

// GET /auth/signup
router.get('/signup', redirectIfLoggedIn, (req, res) => {
  res.render('signup', { error: null });
});

// POST /auth/signup
router.post('/signup', async (req, res) => {
  const { firmName, email, password } = req.body;

  if (!firmName || !email || !password) {
    return res.render('signup', { error: 'All fields are required' });
  }

  try {
    // Create auth user
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true
    });

    if (authError) {
      console.error('Signup auth error:', authError);
      return res.render('signup', { error: authErrorMessage(authError) });
    }

    // Insert firm
    const { data: firmData, error: firmError } = await supabaseAdmin
      .from('firms')
      .insert({ user_id: authData.user.id, name: firmName })
      .select()
      .single();

    if (firmError) {
      console.error('Signup firm insert error:', firmError);
      return res.render('signup', { error: authErrorMessage(firmError) });
    }

    // Set session
    req.session.userId = authData.user.id;
    req.session.firmId = firmData.id;
    req.session.firmName = firmData.name;

    res.redirect('/dashboard');
  } catch (error) {
    console.error('Signup request failed:', error);
    res.status(503).render('signup', { error: authErrorMessage(error) });
  }
});

// GET /auth/login
router.get('/login', redirectIfLoggedIn, (req, res) => {
  res.render('login', { error: null });
});

// POST /auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      console.error('Login auth error:', error);
      return res.render('login', { error: authErrorMessage(error) });
    }

    // Get firm
    const { data: firmData, error: firmError } = await supabaseAdmin
      .from('firms')
      .select('*')
      .eq('user_id', data.user.id)
      .single();

    if (firmError || !firmData) {
      if (firmError) console.error('Login firm lookup error:', firmError);
      return res.render('login', { error: firmError ? authErrorMessage(firmError) : 'Firm not found for this account' });
    }

    req.session.userId = data.user.id;
    req.session.firmId = firmData.id;
    req.session.firmName = firmData.name;

    res.redirect('/dashboard');
  } catch (error) {
    console.error('Login request failed:', error);
    res.status(503).render('login', { error: authErrorMessage(error) });
  }
});

// POST /auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/auth/login');
  });
});

module.exports = router;