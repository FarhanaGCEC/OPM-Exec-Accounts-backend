require('dotenv').config();
const mysql = require('mysql2/promise');
const net = require('node:net');
const { spawn } = require('node:child_process');

function classifyMysqlError(err) {
  const msg = String((err && err.message) || err);
  const code = err && err.code;

  if (code === 'ETIMEDOUT' || msg.includes('ETIMEDOUT')) return 'timeout';
  if (code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED')) return 'refused';
  if (code === 'ENOTFOUND' || msg.includes('ENOTFOUND')) return 'dns';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'unreachable';

  if (code === 'ER_ACCESS_DENIED_ERROR' || msg.includes('Access denied')) return 'access_denied';
  if (msg.includes("Host '") && msg.includes('is not allowed to connect')) return 'host_not_allowed';

  if (msg.toLowerCase().includes('ssl') || msg.toLowerCase().includes('tls')) return 'ssl';

  return 'unknown';
}

function printHelpfulFixes(kind, err) {
  const code = err && err.code;
  console.error('\nConnection failed:', { code, message: err && err.message });

  if (kind === 'host_not_allowed') {
    console.error(
      [
        '\nFix:',
        '- In cPanel: Remote MySQL → add your PUBLIC IP (or %) to allowlist.',
        '- Ensure the MySQL user has privileges for that host (often auto-handled by cPanel).',
      ].join('\n')
    );
  } else if (kind === 'timeout' || kind === 'unreachable') {
    console.error(
      [
        '\nFix:',
        '- Port 3306 may be blocked by firewall/provider.',
        '- Use an SSH tunnel (set USE_SSH_TUNNEL=true) or ask hosting to open 3306 for your IP.',
      ].join('\n')
    );
  } else if (kind === 'refused') {
    console.error(
      [
        '\nFix:',
        '- Wrong host/port, or MySQL not listening on public interface.',
        '- On many cPanel hosts, direct remote MySQL is disabled; use SSH tunnel.',
      ].join('\n')
    );
  } else if (kind === 'dns') {
    console.error(
      ['\nFix:', '- DB_HOST is not resolving. Try server IP or exact MySQL hostname from hosting.'].join(
        '\n'
      )
    );
  } else if (kind === 'access_denied') {
    console.error(
      [
        '\nFix:',
        '- Verify DB_USER / DB_PASSWORD / DB_NAME.',
        '- Confirm the user is assigned to the database in cPanel and has privileges.',
      ].join('\n')
    );
  } else if (kind === 'ssl') {
    console.error(
      [
        '\nFix:',
        '- If hosting requires SSL, set DB_SSL=true and provide CA if they give one.',
        '- If hosting does NOT support SSL, keep DB_SSL=false.',
      ].join('\n')
    );
  }
}

function envBool(key, fallback = false) {
  const raw = process.env[key];
  if (raw == null) return fallback;
  return String(raw).toLowerCase() === 'true';
}

async function ensureSshTunnel() {
  if (!envBool('USE_SSH_TUNNEL', false)) return null;

  const localPort = Number(process.env.SSH_LOCAL_PORT || 3307);
  const dbHost = process.env.DB_HOST;
  const dbPort = Number(process.env.DB_PORT || 3306);

  const listening = await new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port: localPort });
    s.on('connect', () => {
      s.end();
      resolve(true);
    });
    s.on('error', () => resolve(false));
  });

  if (!listening) {
    const sshHost = process.env.SSH_HOST;
    const sshUser = process.env.SSH_USER;
    const sshPort = Number(process.env.SSH_PORT || 22);
    const keyPath = process.env.SSH_PRIVATE_KEY_PATH;

    if (!sshHost || !sshUser || !keyPath) {
      throw new Error('Missing SSH_HOST / SSH_USER / SSH_PRIVATE_KEY_PATH for SSH tunnel.');
    }

    const args = [
      '-i',
      keyPath,
      '-p',
      String(sshPort),
      '-N',
      '-L',
      `${localPort}:${dbHost}:${dbPort}`,
      `${sshUser}@${sshHost}`,
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'ServerAliveCountMax=3',
    ];

    const child = spawn('ssh', args, { stdio: 'inherit' });

    await new Promise((r) => setTimeout(r, 1500));

    child.on('exit', (code) => {
      if (code && code !== 0) console.error('SSH tunnel exited with code', code);
    });
  }

  return { host: '127.0.0.1', port: localPort };
}

async function connectWithRetry({ attempts = 3, delayMs = 1500 } = {}) {
  let lastErr;

  for (let i = 1; i <= attempts; i++) {
    try {
      const tunnel = await ensureSshTunnel();

      const conn = await mysql.createConnection({
        host: (tunnel && tunnel.host) || process.env.DB_HOST,
        port: (tunnel && tunnel.port) || Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        ssl: envBool('DB_SSL', false) ? { rejectUnauthorized: true } : undefined,
        connectTimeout: 10_000,
      });

      return conn;
    } catch (err) {
      lastErr = err;
      const kind = classifyMysqlError(err);
      printHelpfulFixes(kind, err);

      if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw lastErr;
}

function quoteIdent(name) {
  return `\`${String(name).replace(/`/g, '``')}\``;
}

async function getTableColumns(conn, tableName) {
  const dbName = process.env.DB_NAME;
  const [rows] = await conn.query(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `,
    [dbName, tableName]
  );
  return rows.map((r) => r.COLUMN_NAME);
}

function pickOrderColumn(columns) {
  const preferred = [
    'createdAt',
    'created_at',
    'createdon',
    'created_on',
    'date',
    'txnDate',
    'transactionDate',
    'updatedAt',
    'updated_at',
    'id',
  ];

  const lowerToActual = new Map(columns.map((c) => [String(c).toLowerCase(), c]));
  for (const p of preferred) {
    const hit = lowerToActual.get(String(p).toLowerCase());
    if (hit) return hit;
  }
  return columns[0] || null;
}

function pickSelectColumns(columns) {
  const wanted = ['id', 'amount', 'createdAt', 'created_at', 'date', 'description'];
  const lowerToActual = new Map(columns.map((c) => [String(c).toLowerCase(), c]));
  const picked = [];
  for (const w of wanted) {
    const hit = lowerToActual.get(String(w).toLowerCase());
    if (hit && !picked.includes(hit)) picked.push(hit);
  }
  return picked.length ? picked : columns.slice(0, 10);
}

async function main() {
  const conn = await connectWithRetry({ attempts: 3 });

  const table = process.env.DB_TABLE || 'transactions';
  const columns = await getTableColumns(conn, table);
  if (!columns.length) throw new Error(`Table "${table}" not found (or no columns).`);

  const orderCol = pickOrderColumn(columns);
  const selectCols = pickSelectColumns(columns);
  const selectSql = selectCols.map(quoteIdent).join(', ');
  const orderSql = orderCol ? ` ORDER BY ${quoteIdent(orderCol)} DESC` : '';

  const [rows] = await conn.query(`SELECT ${selectSql} FROM ${quoteIdent(table)}${orderSql} LIMIT 20`);

  console.log('Rows:', rows);
  await conn.end();
}

main().catch((e) => {
  console.error('\nFatal:', (e && e.message) || e);
  process.exit(1);
});

