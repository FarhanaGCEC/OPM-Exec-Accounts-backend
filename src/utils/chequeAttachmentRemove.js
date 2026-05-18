/** True when client wants to delete the stored cheque scan (edit flows). */
function payloadWantsRemoveAttachment(body) {
  if (!body || typeof body !== 'object') return false;
  const v =
    body.removeAttachment ??
    body.remove_attachment ??
    body.clearAttachment ??
    body.clear_attachment ??
    body.removeChequeAttachment ??
    body.remove_cheque_attachment;
  if (v === true || v === 1) return true;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }
  return false;
}

module.exports = { payloadWantsRemoveAttachment };
