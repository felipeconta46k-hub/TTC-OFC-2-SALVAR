require('dotenv').config();

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const products = require('./catalog');

const app = express();
const port = Number(process.env.PORT || 3000);
const baseUrl = (process.env.APP_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const orderIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sellerCookieName = 'uf_seller_session';

const coupons = {
  URBAN10: { type: 'percent', value: 10 },
  FLOW15: { type: 'percent', value: 15 },
  PROMO20: { type: 'fixed', value: 2000 },
  FRETE: { type: 'shipping', value: 0 }
};

if (baseUrl.startsWith('https://')) app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));

function isNonEmptyString(value, maxLength = 200) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function tlv(id, value) {
  return `${id}${String(Buffer.byteLength(value, 'utf8')).padStart(2, '0')}${value}`;
}

function crc16Ccitt(value) {
  let crc = 0xffff;
  for (const byte of Buffer.from(value, 'utf8')) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function normalizePixMerchantField(value, maxLength) {
  return value.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 $%*+\-./:]/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function createPixPayload({ amountCents, txid }) {
  const merchantName = normalizePixMerchantField(process.env.PIX_RECEIVER_NAME, 25);
  const merchantCity = normalizePixMerchantField(process.env.PIX_RECEIVER_CITY, 15);
  if (!merchantName || !merchantCity) {
    throw new Error('O nome do recebedor ou a cidade não podem ser usados no QR Pix.');
  }

  const merchantAccount = tlv('00', 'BR.GOV.BCB.PIX') + tlv('01', process.env.PIX_KEY.trim());
  const additionalData = tlv('05', txid);
  const payload =
    tlv('00', '01') +
    tlv('01', '11') +
    tlv('26', merchantAccount) +
    tlv('52', '0000') +
    tlv('53', '986') +
    tlv('54', (amountCents / 100).toFixed(2)) +
    tlv('58', 'BR') +
    tlv('59', merchantName) +
    tlv('60', merchantCity) +
    tlv('62', additionalData) +
    '6304';

  return `${payload}${crc16Ccitt(payload)}`;
}

function calculateOrder(body) {
  if (!body || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) {
    return { error: 'Carrinho inválido.' };
  }

  const customer = body.customer;
  if (!customer || !isNonEmptyString(customer.name, 120) ||
      typeof customer.email !== 'string' ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email) ||
      customer.email.length > 254) {
    return { error: 'Informe um nome e e-mail válidos.' };
  }

  const address = body.address;
  const requiredAddressFields = ['street', 'number', 'city', 'state', 'cep'];
  if (!address || requiredAddressFields.some(field => !isNonEmptyString(address[field], 120)) ||
      !/^\d{5}-?\d{3}$/.test(address.cep.trim()) ||
      !/^[a-z]{2}$/i.test(address.state.trim())) {
    return { error: 'Informe um endereço de entrega válido.' };
  }

  const items = [];
  for (const rawItem of body.items) {
    const id = Number(rawItem && rawItem.id);
    const quantity = Number(rawItem && rawItem.quantity);
    const product = products.get(id);
    if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      return { error: 'Há um produto ou uma quantidade inválida no carrinho.' };
    }
    const selectedSize = rawItem.selectedSize == null ? null : String(rawItem.selectedSize).slice(0, 20);
    items.push({
      id,
      title: product.title,
      quantity,
      selectedSize,
      unitPriceCents: product.priceCents,
      lineTotalCents: product.priceCents * quantity
    });
  }

  const subtotalCents = items.reduce((sum, item) => sum + item.lineTotalCents, 0);
  const couponCode = typeof body.coupon === 'string' ? body.coupon.trim().toUpperCase() : '';
  const coupon = couponCode ? coupons[couponCode] : null;
  if (couponCode && !coupon) return { error: 'Cupom inválido.' };

  let discountCents = 0;
  let shippingCents = subtotalCents >= 29900 ? 0 : 2990;
  if (coupon?.type === 'percent') discountCents = Math.round(subtotalCents * coupon.value / 100);
  if (coupon?.type === 'fixed') discountCents = Math.min(coupon.value, subtotalCents);
  if (coupon?.type === 'shipping') shippingCents = 0;

  return {
    customer: { name: customer.name.trim(), email: customer.email.trim().toLowerCase() },
    address: {
      name: String(address.name || customer.name).trim().slice(0, 120),
      cep: address.cep.trim(),
      street: address.street.trim(),
      number: address.number.trim(),
      complement: String(address.complement || '').trim().slice(0, 120),
      neighborhood: String(address.neighborhood || '').trim().slice(0, 120),
      city: address.city.trim(),
      state: address.state.trim().toUpperCase()
    },
    items,
    couponCode: coupon ? couponCode : null,
    subtotalCents,
    discountCents,
    shippingCents,
    totalCents: subtotalCents - discountCents + shippingCents
  };
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(cookie => {
    const separator = cookie.indexOf('=');
    return separator < 0
      ? ['', '']
      : [cookie.slice(0, separator).trim(), cookie.slice(separator + 1).trim()];
  }).filter(([name]) => name));
}

function signSellerSession(value) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(value).digest('hex');
}

function isSellerAuthenticated(req) {
  const token = parseCookies(req.get('cookie'))[sellerCookieName];
  if (!token) return false;

  const separator = token.lastIndexOf('.');
  if (separator < 1) return false;
  const value = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const [expiresAt, nonce] = value.split('.');
  if (!/^\d+$/.test(expiresAt) || !/^[a-f0-9]{64}$/i.test(signature) ||
      !/^[a-f0-9]{32}$/i.test(nonce) || Number(expiresAt) <= Date.now()) return false;

  const expected = Buffer.from(signSellerSession(value), 'hex');
  const actual = Buffer.from(signature, 'hex');
  return crypto.timingSafeEqual(expected, actual);
}

function requireSeller(req, res, next) {
  if (!isSellerAuthenticated(req)) return res.status(401).json({ error: 'Entre no painel do vendedor.' });
  next();
}

function requireSameOrigin(req, res, next) {
  let origin;
  try {
    origin = new URL(req.get('origin') || '').origin;
  } catch {
    return res.status(403).json({ error: 'Origem da solicitação não permitida.' });
  }
  if (origin !== new URL(baseUrl).origin) return res.status(403).json({ error: 'Origem da solicitação não permitida.' });
  next();
}

const sellerLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.' }
});

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Falha no health check do banco:', error.message);
    res.status(503).json({ status: 'unavailable' });
  }
});

app.post('/api/checkout', async (req, res) => {
  const order = calculateOrder(req.body);
  if (order.error) return badRequest(res, order.error);

  const id = crypto.randomUUID();
  const txid = id.replace(/-/g, '').slice(0, 25).toUpperCase();
  try {
    const pixPayload = createPixPayload({ amountCents: order.totalCents, txid });
    const qrCode = await QRCode.toDataURL(pixPayload, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 280
    });

    await pool.query(
      `INSERT INTO orders
       (id, customer_name, customer_email, address, items, coupon_code,
        subtotal_cents, discount_cents, shipping_cents, total_cents, pix_txid, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending')`,
      [
        id,
        order.customer.name,
        order.customer.email,
        JSON.stringify(order.address),
        JSON.stringify(order.items),
        order.couponCode,
        order.subtotalCents,
        order.discountCents,
        order.shippingCents,
        order.totalCents,
        txid
      ]
    );

    res.status(201).json({
      orderId: id,
      totalCents: order.totalCents,
      pixPayload,
      qrCode,
      receiverName: process.env.PIX_RECEIVER_NAME
    });
  } catch (error) {
    console.error('Falha ao criar pedido Pix:', error.message);
    res.status(500).json({ error: 'Não foi possível gerar o pedido Pix. Tente novamente.' });
  }
});

app.get('/api/orders/:id/status', async (req, res) => {
  if (!orderIdPattern.test(req.params.id)) return res.status(404).json({ error: 'Pedido não encontrado.' });
  try {
    const result = await pool.query(
      'SELECT id, status, total_cents, paid_at, created_at FROM orders WHERE id = $1',
      [req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Pedido não encontrado.' });
    const order = result.rows[0];
    res.json({
      id: order.id,
      status: order.status,
      totalCents: order.total_cents,
      paidAt: order.paid_at,
      createdAt: order.created_at
    });
  } catch (error) {
    console.error('Falha ao consultar pedido:', error.message);
    res.status(500).json({ error: 'Não foi possível consultar o pedido.' });
  }
});

app.post('/api/seller/login', requireSameOrigin, sellerLoginLimiter, (req, res) => {
  const password = req.body?.password;
  if (typeof password !== 'string' || password.length > 512) {
    return res.status(400).json({ error: 'Informe a senha do vendedor.' });
  }

  const receivedDigest = crypto.createHash('sha256').update(password).digest();
  const expectedDigest = crypto.createHash('sha256').update(process.env.SELLER_PASSWORD).digest();
  if (!crypto.timingSafeEqual(receivedDigest, expectedDigest)) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }

  const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
  const value = `${expiresAt}.${crypto.randomBytes(16).toString('hex')}`;
  const token = `${value}.${signSellerSession(value)}`;
  res.cookie(sellerCookieName, token, {
    httpOnly: true,
    secure: baseUrl.startsWith('https://'),
    sameSite: 'strict',
    path: '/api/seller',
    maxAge: 8 * 60 * 60 * 1000
  });
  res.json({ authenticated: true });
});

app.post('/api/seller/logout', requireSameOrigin, (_req, res) => {
  res.clearCookie(sellerCookieName, {
    httpOnly: true,
    secure: baseUrl.startsWith('https://'),
    sameSite: 'strict',
    path: '/api/seller'
  });
  res.sendStatus(204);
});

app.get('/api/seller/session', requireSeller, (_req, res) => res.json({ authenticated: true }));

app.get('/api/seller/orders', requireSeller, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, customer_name, customer_email, address, items, subtotal_cents,
              discount_cents, shipping_cents, total_cents, pix_txid, status, created_at, paid_at
       FROM orders
       ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at DESC
       LIMIT 200`
    );
    res.json({ orders: result.rows });
  } catch (error) {
    console.error('Falha ao carregar pedidos do vendedor:', error.message);
    res.status(500).json({ error: 'Não foi possível carregar os pedidos.' });
  }
});

app.post('/api/seller/orders/:id/confirm-payment', requireSameOrigin, requireSeller, async (req, res) => {
  if (!orderIdPattern.test(req.params.id)) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (req.body?.confirmedReceived !== true) {
    return badRequest(res, 'Confirme que verificou o crédito no extrato do banco.');
  }

  try {
    const result = await pool.query(
      `UPDATE orders
       SET status = 'paid', paid_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING id, status, paid_at`,
      [req.params.id]
    );
    if (!result.rowCount) {
      const existing = await pool.query('SELECT id, status FROM orders WHERE id = $1', [req.params.id]);
      if (!existing.rowCount) return res.status(404).json({ error: 'Pedido não encontrado.' });
      return res.status(409).json({ error: `Este pedido não está pendente (status: ${existing.rows[0].status}).` });
    }
    res.json({ order: result.rows[0] });
  } catch (error) {
    console.error('Falha ao confirmar pagamento do pedido:', error.message);
    res.status(500).json({ error: 'Não foi possível atualizar o pedido.' });
  }
});

app.get('/vendedor', (_req, res) => res.sendFile(path.join(__dirname, 'seller.html')));
app.get('/seller.js', (_req, res) => res.sendFile(path.join(__dirname, 'seller.js')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
for (const asset of ['app.js', 'styles.css', 'mobile-fix.css']) {
  app.get(`/${asset}`, (_req, res) => res.sendFile(path.join(__dirname, asset)));
}

app.use((error, _req, res, _next) => {
  console.error('Erro inesperado no servidor:', error.message);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

async function start() {
  if (!process.env.DATABASE_URL) throw new Error('Configure DATABASE_URL.');
  if (!isNonEmptyString(process.env.PIX_KEY, 77) || /\s/.test(process.env.PIX_KEY)) {
    throw new Error('Configure uma PIX_KEY válida, sem espaços.');
  }
  if (!isNonEmptyString(process.env.PIX_RECEIVER_NAME, 25) ||
      !isNonEmptyString(process.env.PIX_RECEIVER_CITY, 15)) {
    throw new Error('Configure PIX_RECEIVER_NAME (até 25 caracteres) e PIX_RECEIVER_CITY (até 15 caracteres).');
  }
  if (!isNonEmptyString(process.env.SELLER_PASSWORD, 512) || process.env.SELLER_PASSWORD.length < 16) {
    throw new Error('Configure uma SELLER_PASSWORD com pelo menos 16 caracteres.');
  }
  if (!isNonEmptyString(process.env.SESSION_SECRET, 512) || process.env.SESSION_SECRET.length < 32) {
    throw new Error('Configure um SESSION_SECRET com pelo menos 32 caracteres.');
  }
  if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
    throw new Error('APP_BASE_URL precisa ser uma URL HTTP ou HTTPS.');
  }
  if (process.env.NODE_ENV === 'production' && !baseUrl.startsWith('https://')) {
    throw new Error('APP_BASE_URL precisa usar HTTPS em produção.');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      address JSONB NOT NULL,
      items JSONB NOT NULL,
      coupon_code TEXT,
      subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
      discount_cents INTEGER NOT NULL CHECK (discount_cents >= 0),
      shipping_cents INTEGER NOT NULL CHECK (shipping_cents >= 0),
      total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
      pix_txid TEXT UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'rejected', 'cancelled', 'refunded', 'chargeback', 'disputed', 'failed')),
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS pix_txid TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
    CREATE UNIQUE INDEX IF NOT EXISTS orders_pix_txid_idx ON orders (pix_txid) WHERE pix_txid IS NOT NULL;
    CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at DESC);
  `);
  app.listen(port, () => console.log(`Urban Flow rodando em ${baseUrl}`));
}

start().catch(error => {
  console.error('Não foi possível iniciar o servidor:', error.message);
  process.exitCode = 1;
});
