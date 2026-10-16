import test from 'node:test';
import assert from 'node:assert/strict';
import {createSession,validateSession} from '../lib/auth.js';
test('dashboard cookie signatures require a private key not a checked-in verifier',()=>{
 const oldCron=process.env.CRON_SECRET;
 const oldDashboard=process.env.DASHBOARD_SESSION_SECRET;
 try{
  delete process.env.CRON_SECRET;
  delete process.env.DASHBOARD_SESSION_SECRET;
  assert.throws(()=>createSession(),/Private dashboard session signing key/);
  assert.equal(validateSession('1760000000.fake'),false);

  process.env.CRON_SECRET='unit-testing-private-secret-123';
  const issued=createSession();
  assert.equal(validateSession(issued),true);
  assert.equal(validateSession(issued.replace(/.$/,'0')),false);
 }finally{
  if(oldCron===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=oldCron;
  if(oldDashboard===undefined)delete process.env.DASHBOARD_SESSION_SECRET;
  else process.env.DASHBOARD_SESSION_SECRET=oldDashboard;
 }
});
