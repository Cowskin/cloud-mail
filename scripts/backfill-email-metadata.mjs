// One-time, bounded metadata backfill. This does not deploy or modify email bodies.
import {execFileSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if (!process.argv.includes('--remote')) throw new Error('Pass --remote explicitly to backfill the production metadata projection');
const cli=resolve(root,'d1-backup-worker/node_modules/.bin/wrangler');
const cwd=resolve(root,'mail-worker');
function query(sql) {
  try {
    return JSON.parse(execFileSync(cli,['d1','execute','cloud-mail-db','--remote','--json','--command',sql],
      {cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000}))[0];
  } catch { throw new Error('Metadata backfill query failed; stopped without retrying a production write'); }
}
const upper=query('SELECT max(email_id) AS id FROM email').results[0].id||0;
let cursor=0,batch=1000,total=0;
while(cursor<upper) {
  const end=Math.min(cursor+batch,upper);
  const result=query(`INSERT OR IGNORE INTO email_metadata
    SELECT email_id,account_id,user_id,type,status,is_del,subject,name,create_time,
      LENGTH(COALESCE(subject,''))+LENGTH(COALESCE(text,''))+LENGTH(COALESCE(content,''))+
      LENGTH(COALESCE(message,''))+LENGTH(COALESCE(cc,''))+LENGTH(COALESCE(bcc,''))
    FROM email WHERE email_id>${cursor} AND email_id<=${end}
      AND email_id NOT IN (SELECT email_id FROM email_metadata WHERE email_id>${cursor} AND email_id<=${end})`);
  const duration=result.meta?.timings?.sql_duration_ms??result.meta?.duration??0;
  total+=result.meta?.changes||0;
  cursor=end;
  if(duration>1000) batch=Math.max(100,Math.floor(batch/2));
  console.log(JSON.stringify({through:cursor,upper,inserted:total,durationMs:duration,nextBatch:batch}));
  if(duration>5000) throw new Error('Slow batch; stopped to protect D1. Inspect load before resuming. Re-running safely skips existing metadata.');
  await new Promise(resolve=>setTimeout(resolve,250));
}
const check=query(`SELECT
  (SELECT count(*) FROM email) AS emails,
  (SELECT count(*) FROM email_metadata) AS metadata,
  (SELECT count(*) FROM email e LEFT JOIN email_metadata m ON m.email_id=e.email_id WHERE m.email_id IS NULL) AS missing,
  (SELECT count(*) FROM email_metadata m LEFT JOIN email e ON e.email_id=m.email_id WHERE e.email_id IS NULL) AS orphaned`).results[0];
console.log(JSON.stringify(check));
if(check.missing||check.orphaned) throw new Error('Metadata coverage is incomplete; do not deploy');
