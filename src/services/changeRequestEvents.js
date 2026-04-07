const { EventEmitter } = require('events');

/** Same-process pub/sub for admin "live" UI (SSE). */
module.exports = new EventEmitter();
