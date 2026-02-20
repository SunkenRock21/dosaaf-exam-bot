const fs = require('fs').promises;
const path = require('path');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

async function readData() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return { registrations: [], settings: {}, nextId: 1 };
  }
}

async function writeData(data) {
  const raw = JSON.stringify(data, null, 2);
  await fs.writeFile(DATA_FILE, raw, 'utf8');
}

async function initStorage() {
  const data = await readData();
  await writeData(data);
}

async function addRegistration(chatId, fullName, phone, attempt) {
  const data = await readData();
  const id = data.nextId++;
  const rec = {
    id,
    chatId,
    fullName,
    phone,
    attempt: Number(attempt),
    submittedAt: new Date().toISOString(),
    invited: false
  };
  data.registrations.push(rec);
  await writeData(data);
  return rec;
}

async function getRegistrations() {
  const data = await readData();
  return data.registrations.slice();
}

async function getRegistrationById(id) {
  const data = await readData();
  return data.registrations.find(r => r.id === Number(id)) || null;
}

async function getRegistrationsByIds(ids) {
  const data = await readData();
  const set = new Set(ids.map(x => Number(x)));
  return data.registrations.filter(r => set.has(r.id));
}

async function markInvited(id) {
  const data = await readData();
  const rec = data.registrations.find(r => r.id === Number(id));
  if (rec) {
    rec.invited = true;
    await writeData(data);
    return true;
  }
  return false;
}

async function markConfirmed(id) {
  const data = await readData();
  const rec = data.registrations.find(r => r.id === Number(id));
  if (rec) {
    rec.invitationAccepted = true;
    rec.invitationAcceptedAt = new Date().toISOString();
    await writeData(data);
    return true;
  }
  return false;
}

async function removeRegistration(id) {
  const data = await readData();
  const before = data.registrations.length;
  data.registrations = data.registrations.filter(r => r.id !== Number(id));
  const after = data.registrations.length;
  if (after < before) {
    await writeData(data);
    return true;
  }
  return false;
}

async function setSetting(key, value) {
  const data = await readData();
  data.settings = data.settings || {};
  data.settings[key] = value;
  await writeData(data);
}

async function getSetting(key) {
  const data = await readData();
  return data.settings ? data.settings[key] : undefined;
}

async function clearRegistrations() {
  const data = await readData();
  data.registrations = [];
  data.nextId = 1;
  await writeData(data);
}

async function setPendingRemovalRequests(adminId, ids) {
  const data = await readData();
  data.pendingRemovalRequests = data.pendingRemovalRequests || {};
  data.pendingRemovalRequests[String(adminId)] = Array.isArray(ids) ? ids.map(x => Number(x)) : [];
  await writeData(data);
}

async function getPendingRemovalRequests(adminId) {
  const data = await readData();
  if (!data.pendingRemovalRequests) return [];
  return data.pendingRemovalRequests[String(adminId)] || [];
}

async function clearPendingRemovalRequests(adminId) {
  const data = await readData();
  if (!data.pendingRemovalRequests) return;
  delete data.pendingRemovalRequests[String(adminId)];
  await writeData(data);
}

async function appendAudit(entry) {
  const data = await readData();
  data.auditLog = data.auditLog || [];
  const e = Object.assign({ when: new Date().toISOString() }, entry || {});
  data.auditLog.push(e);
  if (data.auditLog.length > 500) data.auditLog = data.auditLog.slice(-500);
  await writeData(data);
}

module.exports = {
  initStorage,
  addRegistration,
  getRegistrations,
  getRegistrationById,
  getRegistrationsByIds,
  markInvited,
  setSetting,
  getSetting,
  markConfirmed,
  removeRegistration,
  clearRegistrations,
  setPendingRemovalRequests,
  getPendingRemovalRequests,
  clearPendingRemovalRequests,
  appendAudit,
  DATA_FILE
};
