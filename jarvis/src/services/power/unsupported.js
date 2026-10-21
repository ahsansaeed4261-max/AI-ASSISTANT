'use strict';

function unsupported() {
  throw new Error('Power actions are not supported on this platform yet.');
}

module.exports = {
  getState: async () => ({
    available: false,
    hibernationEnabled: false,
    hibernationSupported: false,
    reason: 'Power state is not available on this platform.',
  }),
  performAction: unsupported,
  cancelScheduledAction: unsupported,
  enableHibernate: unsupported,
};
