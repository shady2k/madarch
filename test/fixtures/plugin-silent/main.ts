/**
 * A fixture plugin that never introduces itself: it sits on its input and
 * says nothing, so the host's handshake deadline is the only way out.
 */
setInterval(() => undefined, 1_000);
