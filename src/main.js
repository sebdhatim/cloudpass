'use strict';

const ssaclCls = require('continuation-local-storage').createNamespace('sequelize-cls');
const express = require('express');
const cluster = require('cluster');
const cookieParser = require('cookie-parser');
const numCPUs = require('os').cpus().length;
const config = require('config');
const ssacl = require('ssacl');
const randomstring = require('randomstring');
const _ = require('lodash');
const winston = require("winston");
const loadLoggingConfig = require('sequelize').Promise.promisify(require('winston-config').fromJson);

config.get('logging.transports').forEach(t => winston.transports[_.upperFirst(t)] = require(t));
module.exports = loadLoggingConfig(config.get('logging.loggers'))
    .then(function(){
        if(cluster.isMaster){
            //run pending migrations and fork clusters
            var secret = config.get('server.secret') || randomstring.generate(50);
            return require('./models').migrate()
                .then(function(){
                    if(config.get('server.clustering') && numCPUs > 1){
                        return _.times(Math.min(numCPUs, 4), cluster.fork.bind(cluster, {secret}));
                    } else {
                        return startServers(secret);
                    }
                });
        } else {
            return startServers(process.env.secret);
        }
});

function startServers(secret){
    //enable ACL
    require('./models').useSsacl(ssacl, ssaclCls);

    //load functional components
    const app = express();
    app.set('secret', secret);
    app.use(cookieParser(secret));
    app.set('ssaclCls', ssaclCls);
    app.get('/', function(req, res){
        res.status(302).location('ui/').end();
    });
    app.use('/login', require('./apps/login'));
    app.use('/logout', require('./apps/logout'));
    app.use('/ui', require('./apps/ui'));
    app.use('/registration', require('./apps/registration'));
    app.use('/adminInvitation', require('./apps/adminInvitation'));
    app.use('/sso', require('./apps/sso'));

    return require('./apps/restApi')(secret)
        .then(function(apiApp){
          app.use('/v1', apiApp);
          //start the main & monitoring servers
          return {
              main: app.listen(config.get('server.port')),
              monitoring: require('./apps/monitoring').listen(config.get('server.monitoringPort'))
          };
        });
}