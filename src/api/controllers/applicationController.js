"use strict";

var BluebirdPromise = require('sequelize').Promise;
var _ = require('lodash');
var controllerHelper = require('../helpers/controllerHelper');
var accountStoreController = require('../helpers/accountStoreController');
var accountHelper = require('../helpers/accountHelper');
var samlHelper = require('../helpers/samlHelper');
var sendEmail = require('../../sendEmail');
var models = require('../../models');
var ApiError = require('../../ApiError');

var controller = accountStoreController(models.application);

function getSubResource(getter, req, res){
    return models.application
        .findById(req.swagger.params.id.value)
        .tap(ApiError.assertFound)
        .then(application => application[getter]())
        .then(_.partial(controllerHelper.expand, _, req))
        .then(res.json.bind(res))
        .catch(req.next);
}
controller.getIdSiteModel = _.partial(getSubResource, 'getIdSiteModel');
controller.getSamlPolicy = _.partial(getSubResource, 'getSamlPolicy');

controller.create = function(req, res){
    var attributes = _.pick(req.swagger.params.attributes.value, models.application.getSettableAttributes());
    attributes.tenantId = req.user.tenantId;
    
    models.sequelize.requireTransaction(function () {
        //create the application
        return models.application
                .create(attributes)
                .tap(function(application){
                    //create a directory if requested
                    var createDirectory = req.swagger.params.createDirectory.value;
                    if(createDirectory){
                        if(createDirectory === "true"){
                            //TODO pick a name that does not already exist
                            createDirectory = req.swagger.params.attributes.value.name;
                        }
                        
                        return models.directory
                                .create({name: createDirectory, tenantId: req.user.tenantId})
                                .then(function(directory){
                                    return models.accountStoreMapping.create(
                                        {
                                           accountStoreId: directory.id,
                                           accountStoreType: 'directory',
                                           listIndex: 0,
                                           isDefaultAccountStore: true,
                                           isDefaultGroupStore: true,
                                           applicationId: application.id,
                                           tenantId: req.user.tenantId
                                        }
                                    );
                                });
                    }
                });
    })
    .then(_.partial(controllerHelper.expand, _, req))
    .then(res.json.bind(res))
    .catch(req.next);
};

controller.authenticate = function(req, res){
    var attempt = req.swagger.params.attempt.value;
    var decodedValue = new Buffer(attempt.value, 'base64').toString('utf8');
    var delimiterIndex = decodedValue.indexOf(':');
    ApiError.assert(delimiterIndex > 0, ApiError, 400, 400, 'Invalid value');
    var login = decodedValue.substring(0, delimiterIndex);
    var password = decodedValue.substring((delimiterIndex + 1));
    
    accountHelper.authenticateAccount(
            login,
            password,
            req.swagger.params.id.value,
            _.defaultTo(_.get(req.authInfo, 'asnk'), _.get(attempt.accountStore, 'nameKey')),
            _.get(attempt.accountStore, 'href')
        )
        .then(function(account){
            res.json(expandAccountActionResult(account, req.swagger.params.expand.value));
        })
        .catch(req.next);
};

controller.createPasswordResetToken = function(req, res){
    accountHelper.findAccount(
            req.swagger.params.attributes.value.email,
            req.swagger.params.id.value,
            _.defaultTo(_.get(req.authInfo, 'onk'), _.get(req.swagger.params.attributes.value.accountStore, 'nameKey')),
            _.get(req.swagger.params.attributes.value.accountStore, 'href')
        )
        .then(function(account){
            ApiError.assert(account, ApiError, 400, 2016,  'The email property value %s does not match a known resource.', req.swagger.params.attributes.value.email);
            ApiError.assert(account.status === 'ENABLED', ApiError, 400, 7101, 'The account is not enabled');
            //get the directory with its password policy and email templates
            return account.getDirectory({
                include: [{
                    model: models.passwordPolicy,
                    include: [{
                        model: models.emailTemplate,
                        as: 'resetEmailTemplates'
                    }]
                }]
            })
            .then(function(directory){
                ApiError.assert(directory.passwordPolicy.resetEmailStatus === 'ENABLED', ApiError, 400, 400, 'the password reset workflow is not enabled');
                
                //create a new token
                var tokenExpiryDate = new Date();
                tokenExpiryDate.setHours(tokenExpiryDate.getHours() + directory.passwordPolicy.resetTokenTtl);
                
                return models.passwordResetToken.create({
                    tenantId: req.user.tenantId,
                    applicationId: req.swagger.params.id.value,
                    accountId: account.id,
                    email: account.email,
                    expires: tokenExpiryDate
                })
                .tap(function(token){
                    //asynchronously send an email with the token
                    sendEmail(
                        account,
                        directory,
                        directory.passwordPolicy.resetEmailTemplates[0],
                        token.id,
                        {expirationWindow: directory.passwordPolicy.resetTokenTtl});
                });
            });
                
        })
        .then(function(token){
           return controllerHelper.expand(token, req);
        })
        .then(_.bindKey(res, 'json'))
        .catch(req.next);
};

controller.getPasswordResetToken = function(req, res){
    models.passwordResetToken.findOne({
        where: {
            id: req.swagger.params.tokenId.value,
            applicationId: req.swagger.params.id.value
        }
    })
    .tap(_.partial(ApiError.assert, _, ApiError.NOT_FOUND))
    .then(_.partial(controllerHelper.expand, _, req))
    .then(_.bindKey(res, 'json'))
    .catch(req.next);
};

controller.consumePasswordResetToken = function(req, res){
    models.sequelize.transaction(function(){
        //find the token
        return models.passwordResetToken.findById(
            req.swagger.params.tokenId.value,
            {
                where: {applicationId: req.swagger.params.id.value},
                include: [{
                    model: models.account,
                    include: [{
                        model: models.directory,
                        include: [{
                            model: models.passwordPolicy
                        }]
                    }]
               }]
            }
        )
        .then(function(token){
            ApiError.assert(token, ApiError.NOT_FOUND);
            ApiError.assert(token.expires >= new Date(), ApiError, 400, 400, 'the token has expired');
            //update the account and delete the token
            return BluebirdPromise.join(
                        token.account.update({password: req.swagger.params.attributes.value.password}),
                        token.destroy()
                    )
                    .get(0);
        });
    })
    .then(function(account){
        //asynchronously send a confirmation email (if it is enabled)
        if(account.directory.passwordPolicy.resetSuccessEmailStatus === 'ENABLED'){
            account.directory.passwordPolicy
                    .getResetSuccessEmailTemplates({limit: 1})
                    .spread(function(template){
                        sendEmail(
                            account,
                            account.directory,
                            template);
                    });
        }
        res.json(expandAccountActionResult(account, req.swagger.params.expand.value));
    })
    .catch(req.next);
    
};

controller.resendVerificationEmail = function(req, res){
    accountHelper.findAccount(
            req.swagger.params.attributes.value.login,
            req.swagger.params.id.value,
            _.defaultTo(_.get(req.authInfo, 'onk'), _.get(req.swagger.params.attributes.value.accountStore, 'nameKey')),
            _.get(req.swagger.params.attributes.value.accountStore, 'href')
        )
        .then(function(account){
            ApiError.assert(account, ApiError.NOT_FOUND);
            if(account.emailVerificationTokenId){
                account.getDirectory({
                    include: [{
                            model: models.accountCreationPolicy,
                            include: [{
                                model: models.emailTemplate,
                                as: 'verificationEmailTemplates',
                                separate: true //workaround for https://github.com/sequelize/sequelize/issues/2084
                            }]
                        }]
                })
                .then(function(directory){
                    sendEmail(
                        account,
                        directory,
                        directory.accountCreationPolicy.verificationEmailTemplates[0],
                        account.emailVerificationTokenId); 
                });
            }
        })
       .then(function(){ res.status(204).json();})
       .catch(req.next);
};

controller.samlIdpRedirect = function(req, res){
    //redirects to SAML idP can either be initiated from the application (with an access token)
    //or from the ID site (with an authorization bearer).
    //when using _.defaultTo here, the first param is found in ID Site bearer
    //while the 2nd one is found in access token
    return BluebirdPromise.join(
        models.application.build({id: req.swagger.params.id.value})
            .getLookupAccountStore(req.authInfo.onk)
            .then(as => accountHelper.getSubAccountStore(as, _.defaultTo(req.swagger.params['accountStore.href'].value, req.authInfo.ash)))
            .then(getSamlDirectoryProvider),
        samlHelper.getRelayState(
            req.user,
            req.authInfo.cb_uri,
            req.authInfo.state,
            _.defaultTo(req.authInfo.app_href, req.authInfo.iss),
            _.defaultTo(req.authInfo.init_jti, req.authInfo.jti),
            '1h'
        )
    )
    .spread(samlHelper.getLoginRequestUrl)
    .then(_.bindKey(res, 'redirect'))
    .catch(req.next);
};

function getSamlDirectoryProvider(accountStore){
    if(accountStore instanceof models.directory.Instance){
        ApiError.assert(accountStore.providerId === 'saml', ApiError, 400, 2014, 'The directory %s is not a SAML directory', accountStore.id);
        return accountStore.getProvider({include: [models.samlServiceProviderMetadata]});
    }
    ApiError.assert(accountStore.getDirectories, ApiError, 400, 2014, 'SAML login in %s is not supported', accountStore.Model.options.name.plural);
    return accountStore.getDirectories({
                attributes: [],
                include: [{
                    model: models.directoryProvider,
                    as: 'provider',
                    where: {providerId: 'saml'},
                    include: [models.samlServiceProviderMetadata]
                }],
                limit: 1
            })
            .then(_.head)
            .tap(_.partial(ApiError.assert, _, ApiError, 404, 2014, 'No SAML provider found in %s %s', accountStore.Model.name, accountStore.id))
            .get('provider');
}

function expandAccountActionResult(account, expand){
    //return the account only if the expand paramter was set
    return expand?account:{account: _.pick(account, 'href')};
}

module.exports = controller;