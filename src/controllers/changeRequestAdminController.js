const ChangeRequest = require('../models/ChangeRequest');
const { executeApprovedRequest } = require('../services/changeRequestExecutor');
const changeRequestEvents = require('../services/changeRequestEvents');

async function listChangeRequests(req, res) {
  const status = req.query.status ? String(req.query.status).toLowerCase() : undefined;
  if (status && !['pending', 'approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    const [requests, pendingCount] = await Promise.all([
      ChangeRequest.listAll({ status }),
      ChangeRequest.countPending(),
    ]);
    return res.json({ requests, pendingCount });
  } catch (error) {
    console.error('listChangeRequests:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/** Server-Sent Events: admins get `new_request` when a user submits; `connected` on join. */
function streamChangeRequestEvents(req, res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const writeEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  writeEvent('connected', { message: 'Subscribed to approval notifications' });

  const onNew = (payload) => writeEvent('new_request', payload);
  const onResolved = (payload) => writeEvent('request_resolved', payload);

  changeRequestEvents.on('new_request', onNew);
  changeRequestEvents.on('request_resolved', onResolved);

  const ping = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`);
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    changeRequestEvents.off('new_request', onNew);
    changeRequestEvents.off('request_resolved', onResolved);
  });
}

async function approveChangeRequest(req, res) {
  const id = parseInt(req.params.id, 10);
  const reviewNote =
    req.body.reviewNote != null
      ? String(req.body.reviewNote)
      : req.body.review_note != null
        ? String(req.body.review_note)
        : null;

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid request id' });
  }

  try {
    const row = await ChangeRequest.findById(id);
    if (!row || row.status !== 'pending') {
      return res.status(404).json({ error: 'Pending request not found' });
    }

    await executeApprovedRequest({
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      requesterId: row.requesterId,
      payload: row.payload,
    });

    const updated = await ChangeRequest.setReviewed(id, {
      status: 'approved',
      reviewedBy: req.user.id,
      reviewNote,
    });

    changeRequestEvents.emit('request_resolved', {
      requestId: id,
      status: 'approved',
      reviewedBy: req.user.id,
    });

    return res.json({ message: 'Approved and applied', request: updated });
  } catch (error) {
    console.error('approveChangeRequest:', error);
    const msg = error && error.message ? String(error.message) : 'Could not apply request';
    return res.status(400).json({ error: msg });
  }
}

async function rejectChangeRequest(req, res) {
  const id = parseInt(req.params.id, 10);
  const reviewNote =
    req.body.reviewNote != null
      ? String(req.body.reviewNote)
      : req.body.review_note != null
        ? String(req.body.review_note)
        : '';

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid request id' });
  }

  try {
    const row = await ChangeRequest.findById(id);
    if (!row || row.status !== 'pending') {
      return res.status(404).json({ error: 'Pending request not found' });
    }

    const updated = await ChangeRequest.setReviewed(id, {
      status: 'rejected',
      reviewedBy: req.user.id,
      reviewNote: reviewNote || null,
    });

    changeRequestEvents.emit('request_resolved', {
      requestId: id,
      status: 'rejected',
      reviewedBy: req.user.id,
    });

    return res.json({ message: 'Request rejected', request: updated });
  } catch (error) {
    console.error('rejectChangeRequest:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  listChangeRequests,
  approveChangeRequest,
  rejectChangeRequest,
  streamChangeRequestEvents,
};
