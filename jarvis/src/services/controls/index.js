'use strict';

const platform = process.platform === 'win32' ? './win32' : './unsupported';
module.exports = require(platform);
