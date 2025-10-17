import pool from '../src/config/db.js';

try {
  const { rows } = await pool.query(`
    select current_user, current_setting('search_path') as sp
  `);
  console.log('DB OK:', rows[0]);
} catch (e) {
  console.error('DB ERROR:', e.message);
} finally {
  await pool.end();
}