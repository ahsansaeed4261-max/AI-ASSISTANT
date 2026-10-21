'use strict';

module.exports = require(process.platform === 'win32' ? './win32' : './unsupported');
