/**
 * cleanup-bad-phones.js
 *
 * Removes conversation/history/lead/summary records whose phone number
 * looks like a WhatsApp internal JID (non-standard digits, @lid suffix, etc.)
 * rather than a real customer phone number.
 *
 * Run with:  node scripts/cleanup-bad-phones.js
 */

import pg from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/** Returns true if the phone string looks like a real number */
function isValidPhone(raw) {
  // Strip prefix like "conv:", "history:", "lead:", "summary:"
  const phone = raw.replace(/^(conv|history|lead|summary):/, '');
  // Must start with + and contain only digits (10-15 digits after country code)
  return /^\+\d{10,15}$/.test(phone);
}

async function main() {
  console.log('Connecting to Neon PostgreSQL...');

  // Fetch all keys that are conversation/lead/history/summary records
  const { rows } = await pool.query(
    `SELECT key FROM kv_store
     WHERE key LIKE 'conv:%'
        OR key LIKE 'history:%'
        OR key LIKE 'lead:%'
        OR key LIKE 'summary:%'
     ORDER BY key`
  );

  console.log(`Found ${rows.length} total records to check.\n`);

  const toDelete = [];
  for (const { key } of rows) {
    if (!isValidPhone(key)) {
      toDelete.push(key);
    }
  }

  if (toDelete.length === 0) {
    console.log('✅ No bad records found. Database is clean!');
    await pool.end();
    return;
  }

  console.log(`⚠️  Found ${toDelete.length} bad records to remove:`);
  toDelete.forEach(k => console.log('  DELETE:', k));

  // Confirm before deleting
  console.log('\nDeleting...');
  for (const key of toDelete) {
    await pool.query('DELETE FROM kv_store WHERE key = $1', [key]);
    console.log('  ✓ Deleted:', key);
  }

  console.log(`\n✅ Cleanup complete. Removed ${toDelete.length} bad records.`);
  await pool.end();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

