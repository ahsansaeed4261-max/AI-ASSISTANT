'use strict';

module.exports = process.platform === 'win32'
  ? require('./win32')
  : require('./unsupported');
