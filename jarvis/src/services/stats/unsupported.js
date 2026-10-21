'use strict';

module.exports = {
  getStats: async () => ({ available: false, reason: 'System statistics are not supported on this platform yet.' }),
};
