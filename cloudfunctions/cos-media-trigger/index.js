'use strict';

const cloudbase = require('@cloudbase/node-sdk');
const { createHandler } = require('./handler');

const app = cloudbase.init({
  env: process.env.CLOUD_ENV_ID || cloudbase.SYMBOL_CURRENT_ENV,
});

exports.main = createHandler({
  environment: process.env,
  callContainer: (options) => app.callContainer(options),
});
