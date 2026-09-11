const {Pool}=require('pg');
const bcrypt=require('bcrypt');
const {randomUUID}=require('crypto');
require('dotenv').config();
async function main(){
 const {DATABASE_URL,SUPER_ADMIN_EMAIL,SUPER_ADMIN_PASSWORD}=process.env;
 if(!DATABASE_URL||!SUPER_ADMIN_EMAIL||!SUPER_ADMIN_PASSWORD||SUPER_ADMIN_PASSWORD.length<12)throw new Error('Set database, email, and a password of at least 12 characters in the environment');
 const pool=new Pool({connectionString:DATABASE_URL});
 try{const hash=await bcrypt.hash(SUPER_ADMIN_PASSWORD,12);
 const r=await pool.query('UPDATE super_admin SET password=$1,updated_at=NOW() WHERE email=$2 RETURNING id',[hash,SUPER_ADMIN_EMAIL]);if(!r.rows.length)throw new Error('Account not found');
 console.log('Account updated. No credentials are logged.');
 }finally{await pool.end();}
}
if(require.main===module)main().catch(()=>{console.error('Account operation failed. Check configuration and database access.');process.exitCode=1;});
module.exports={main};
