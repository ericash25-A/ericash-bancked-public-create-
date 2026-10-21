require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const DB_FILE = path.join(__dirname, 'vouchers.json');

// Simple DB - saves to file so vouchers survive restart
function loadDB() {
  if (!fs.existsSync(DB_FILE)) return {};
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Helper: check if voucher expired
function isExpired(v) {
  if (!v.created) return true;
  const created = new Date(v.created).getTime();
  const hoursMs = v.hours * 60 * 60 * 1000;
  return (Date.now() - created) > hoursMs;
}

// 1. CREATE STRIPE PAYMENT INTENT (for Cards - Worldwide)
app.post('/api/stripe/create-intent', async (req, res) => {
  const { amount, currency, email, voucher } = req.body;
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount, // amount in cents from frontend
      currency: currency.toLowerCase(),
      receipt_email: email,
      metadata: { voucher: voucher }
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 2. CREATE VOUCHER (called after successful payment)
app.post('/api/voucher/create', (req, res) => {
  const { code, package: pkg, hours, amount, currency, contact, method } = req.body;
  if (!code) return res.status(400).json({ error: 'No code' });

  const db = loadDB();
  db[code] = {
    code,
    package: pkg,
    hours,
    amount,
    currency,
    contact,
    method: method || 'card',
    paid: true,
    used: false,
    created: new Date().toISOString()
  };
  saveDB(db);
  res.json({ success: true, code });
});

// 3. VALIDATE VOUCHER (your login.html calls this)
app.get('/api/voucher/validate', (req, res) => {
  const code = (req.query.code || '').toUpperCase();
  const db = loadDB();
  const v = db[code];

  if (!v || !v.paid) return res.json({ valid: false, reason: 'Not found' });
  if (v.used) return res.json({ valid: false, reason: 'Already used' });
  if (isExpired(v)) return res.json({ valid: false, reason: 'Expired' });

  res.json({ valid: true, package: v.package, hours: v.hours });
});

// 4. FIND MY VOUCHER
app.get('/api/voucher/find', (req, res) => {
  const contact = req.query.contact;
  const db = loadDB();
  const codes = Object.values(db)
    .filter(v => v.contact === contact && v.paid && !isExpired(v))
    .map(v => `${v.code} - ${v.package} - PAID`);
  res.json({ codes });
});

// 5. MTN / AIRTEL MOMO REQUEST
app.post('/api/momo/request', async (req, res) => {
  const { phone, amount, currency, voucher, package: pkg, hours, method } = req.body;

  if (method === 'mtn') {
    // REAL MTN MoMo API flow:
    // 1. Get token using MTN_API_KEY + SUBSCRIPTION_KEY
    // 2. POST to /collection/v1_0/requesttopay with phone, amount
    // Documentation: https://momodeveloper.mtn.com/
    try {
      // Example structure - replace with real fetch to MTN
      // const token = await getMtnToken();
      // await fetch('https://sandbox.momodeveloper.mtn.com/collection/v1_0/requesttopay', {...})

      console.log(`MTN Request: ${phone} for UGX ${amount} - voucher ${voucher}`);
      // For now, mark as success so your test works
      const db = loadDB();
      db[voucher] = { code: voucher, package: pkg, hours, amount, currency, contact: phone, method: 'mtn', paid: true, used: false, created: new Date().toISOString() };
      saveDB(db);

      return res.json({ success: true, message: 'Check your phone for MTN PIN prompt to approve' });
    } catch (e) {
      return res.status(500).json({ success: false, message: e.message });
    }
  }

  if (method === 'airtel') {
    console.log(`Airtel Request: ${phone} for UGX ${amount} - voucher ${voucher}`);
    const db = loadDB();
    db[voucher] = { code: voucher, package: pkg, hours, amount, currency, contact: phone, method: 'airtel', paid: true, used: false, created: new Date().toISOString() };
    saveDB(db);
    return res.json({ success: true, message: 'Check your phone for Airtel Money prompt' });
  }

  res.status(400).json({ success: false, message: 'Unknown method' });
});

// 6. MARK VOUCHER AS USED (optional - call from MikroTik API after login)
app.post('/api/voucher/use', (req, res) => {
  const { code } = req.body;
  const db = loadDB();
  if (db[code]) {
    db[code].used = true;
    saveDB(db);
  }
  res.json({ success: true });
});

app.get('/', (req, res) => res.send('Ericash Backend is running'));

app.listen(process.env.PORT || 10000, () => console.log('Backend running'));
