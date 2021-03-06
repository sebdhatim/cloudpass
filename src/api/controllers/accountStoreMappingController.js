"use strict";

var baseController = require('../helpers/baseController');
var models = require('../../models');

module.exports = baseController(models.accountStoreMapping, ['create', 'update', 'delete']);