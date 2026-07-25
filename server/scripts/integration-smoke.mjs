import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';

const baseUrl = process.env.TEST_API_URL ?? 'http://127.0.0.1:18080/api/v1';
const run = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.openId ? { 'x-dev-openid': options.openId } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

async function ok(path, options) {
  const result = await request(path, options);
  assert.ok(result.status >= 200 && result.status < 300, `${path}: ${result.status} ${JSON.stringify(result.payload)}`);
  return result.payload.data;
}

async function login(name) {
  const openId = `integration_${name}_${run}`;
  const data = await ok('/auth/wechat/login', {
    method: 'POST',
    openId,
    body: { clientRequestId: `login_${name}_${run}` },
  });
  return { token: data.accessToken, openId };
}

async function waitFor(check, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('timed out waiting for background job');
}

const ownerSession = await login('owner');
const applicantSessions = await Promise.all(['two', 'three', 'four', 'five'].map(login));
const owner = ownerSession.token;
const applicants = applicantSessions.map((session) => session.token);
const module = await ok('/modules', {
  method: 'POST', token: owner,
  body: { name: '联调模块', description: run, clientRequestId: `module_${run}` },
});
const invite = await ok(`/modules/${module.moduleId}/invites`, {
  method: 'POST', token: owner, body: { clientRequestId: `invite_${run}` },
});

const applications = await Promise.all(applicants.map((token, index) => ok(`/invites/${encodeURIComponent(invite.inviteId)}/applications`, {
  method: 'POST', token, body: { clientRequestId: `apply_${index}_${run}` },
})));
const approvals = await Promise.all(applications.map((application, index) => request(`/join-applications/${application.applicationId}/approve`, {
  method: 'POST', token: owner, body: { clientRequestId: `approve_${index}_${run}` },
})));
assert.equal(approvals.filter((item) => item.status === 200).length, 3, 'exactly three applicants should be approved');
assert.equal(approvals.filter((item) => item.status === 409 && item.payload.code === 'MODULE_MEMBER_LIMIT_REACHED').length, 1);
const members = await ok(`/modules/${module.moduleId}/members`, { token: owner });
assert.equal(members.activeMemberCount, 4);
assert.equal(members.inviteAvailable, false);

const imageBody = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgQIAK5G4WQAAAABJRU5ErkJggg==', 'base64');
const media = await ok('/media', {
  method: 'POST', token: owner,
  body: {
    moduleId: module.moduleId,
    purpose: 'record_photo', sourceType: 'camera', fileName: 'integration.png', mimeType: 'image/png', fileSize: imageBody.length,
    clientRequestId: `media_${run}`,
  },
});
const localUpload = await fetch(`${baseUrl}/dev-storage/upload?key=${encodeURIComponent(media.upload.cloudPath)}`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/octet-stream' },
  body: imageBody,
});
assert.equal(localUpload.status, 200, `local object upload failed: ${localUpload.status} ${await localUpload.text()}`);
await ok(`/media/${media.mediaId}/upload-complete`, {
  method: 'POST', token: owner,
  body: { etag: 'integration-etag', fileSize: imageBody.length, mimeType: 'image/png', width: 1, height: 1, clientRequestId: `uploaded_${run}` },
});
await waitFor(async () => {
  const state = await ok(`/media/${media.mediaId}`, { token: owner });
  return state.status === 'ready' ? state : null;
});

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const record = await ok(`/modules/${module.moduleId}/records`, {
  method: 'POST', token: owner,
  body: { recordDate: today, mediaId: media.mediaId, remark: 'integration', clientRequestId: `record_${run}` },
});
assert.equal(record.status, 'active');

const month = today.slice(0, 7);
const card = await ok(`/memories/monthly-card?moduleId=${module.moduleId}&month=${month}`, { token: owner });
assert.ok(card.memoryCardId);
assert.equal(card.items.length, 1);
await ok('/memories/monthly-card/export', {
  method: 'POST', token: owner,
  body: { moduleId: module.moduleId, month, clientRequestId: `export_${run}` },
});
const exported = await waitFor(async () => {
  const state = await ok(`/memories/monthly-card?moduleId=${module.moduleId}&month=${month}`, { token: owner });
  return state.generatedImageUrl ? state : null;
});
assert.equal(exported.exportStatus, 'ready');

const deleteResult = await ok(`/modules/${module.moduleId}/delete`, {
  method: 'POST', token: owner,
  body: { confirmationName: '联调模块', clientRequestId: `delete_${run}` },
});
assert.equal(deleteResult.status, 'pending_delete');
const restoreResult = await ok(`/modules/${module.moduleId}/restore`, {
  method: 'POST', token: owner, body: { clientRequestId: `restore_${run}` },
});
assert.equal(restoreResult.status, 'active');

await ok('/users/me/deletion-request', {
  method: 'POST', token: owner, body: { clientRequestId: `delete_account_${run}` },
});
const [mysqlHost, mysqlPort = '3306'] = String(process.env.MYSQL_ADDRESS).split(':');
const connection = await mysql.createConnection({
  host: mysqlHost,
  port: Number(mysqlPort),
  user: process.env.MYSQL_USERNAME,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE ?? 'record_life',
});
const [ownerRows] = await connection.execute('SELECT user_id FROM user_account WHERE open_id = ? LIMIT 1', [ownerSession.openId]);
const ownerUserId = String(ownerRows[0].user_id);
await connection.execute(
  `UPDATE account_deletion_request adr
    JOIN user_account u ON u.user_id = adr.user_id
       SET adr.execute_after = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND)
     WHERE u.open_id = ? AND adr.status = 'cooling_off'`,
  [ownerSession.openId],
);
await connection.execute(
  `UPDATE scheduled_job_run SET status = 'failed', locked_by = NULL, lock_expires_at = NULL
    WHERE job_name = 'account_deletion' AND status = 'completed'
    ORDER BY job_run_id DESC LIMIT 1`,
);
await waitFor(async () => {
  const [rows] = await connection.execute(
    `SELECT u.status,
            (SELECT COUNT(*) FROM life_record r WHERE r.user_id = u.user_id) AS records,
            (SELECT COUNT(*) FROM media_asset ma WHERE ma.owner_user_id = u.user_id) AS media
       FROM user_account u WHERE u.user_id = ? LIMIT 1`,
    [ownerUserId],
  );
  return rows[0]?.status === 'deleted' && Number(rows[0].records) === 0 && Number(rows[0].media) === 0;
}, 40_000);
await connection.end();

process.stdout.write(JSON.stringify({
  moduleId: module.moduleId,
  members: members.activeMemberCount,
  rejectedAtCapacity: 1,
  recordId: record.recordId,
  memoryCardId: card.memoryCardId,
  exportReady: true,
  recycleRestore: true,
  accountDeletionCompleted: true,
}, null, 2));
