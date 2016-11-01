"use strict";

var samlHelper = require('../helpers/samlHelper');
var models = require('../../models');
var ApiError = require('../../ApiError');

exports.get = function(req, res){
    // SAML service provider ID = application ID
    models.application
        .findById(req.swagger.params.id.value)
        .tap(ApiError.assertFound)
        .call('getSamlPolicy')
        .call('getServiceProvider')
        .then(res.json.bind(res))
        .catch(req.next);
};

exports.generateDefaultRelayState = function(req, res){
    //An API key is necessary to sign callback JWTs.
    //But after cookie authentication (i.e. from the UI), no API key is
    //associated to the request.
    ApiError.assert(req.user.id, ApiError.FORBIDDEN);
    samlHelper.getRelayState(
        req.user,
        req.swagger.params.properties.value.callbackUri,
        req.swagger.params.properties.value.state,
        models.application.getHref(req.swagger.params.id.value)
    )
    .then(function(relayState){
        res.json({defaultRelayState: relayState});
    });
};