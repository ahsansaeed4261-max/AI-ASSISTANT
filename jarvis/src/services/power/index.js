'use strict';

const platformService = process.platform === 'win32'
  ? './win32'
  : process.platform === 'linux'
    ? './linux'
    : './unsupported';

module.exports = require(platformService);
