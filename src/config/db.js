// src/config/db.js
import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

if (!process.env.DATABASE_URL) {
  throw new Error('Falta DATABASE_URL en .env');
}

const u = new URL(process.env.DATABASE_URL);
const pool = new Pool({
  user: decodeURIComponent(u.username || ''),
  password: String(decodeURIComponent(u.password || '')),
  host: u.hostname || 'localhost',
  port: Number(u.port || 5432),
  database: u.pathname.replace(/^\//, '') || 'postgres',
  application_name: 'doa-back',
});

pool.on('connect', (client) => {
  client.query(`SET search_path TO seguridadjci, doa2, public`).catch(e =>
    console.error('SET search_path error:', e.message)
  );
});

pool.on('error', (err) => console.error('🐛 Pool error:', err.message));
export default pool;