var assert = require('assert');
var url = require('url');
var init = require('./init');
var BluebirdPromise = require('sequelize').Promise;
var request = require('supertest');

describe('admin invitation', function(){
    var mailServer;
    before(function () {
       mailServer = init.getMailServer();
    });

    after(function () {
        mailServer.stop();
    });

    it('workflow', function(){
        var invitedEmail = 'invited@example.com';

        return BluebirdPromise.join(
                    // send an invitation email
                    init.getEmailPromise(mailServer, invitedEmail),
                    init.postRequest('tenants/'+init.apiKey.tenantId+'/invitationEmails')
                        .send({
                            to: [invitedEmail],
                            subject: 'invitation',
                            textBody: '${url}',
                            linkPath: 'adminInvitation.html'
                        })
                        .expect(204)
                )
                .spread(function(email){
                    //consume the invitation
                    return request(init.servers.main).get('/adminInvitation'+url.parse(email.body).search)
                            .expect(200);
                })
                .then(function(res){
                    assert(res.body.id);
                    assert(res.body.fromAccount.fullName);
                    assert(res.body.tenant.key);
                    assert.strictEqual(res.body.email, invitedEmail);
                    return request(init.servers.main).post('/adminInvitation')
                        .send('invitationId='+res.body.id)
                        .send('givenName=test')
                        .send('surname=test')
                        .send('password=Aa123456')
                        .expect(204);
                })
                .then(function(){
                    //the new admin should be able to login
                    return request(init.servers.main)
                        .post('/login')
                        .send('tenantNameKey=test-tenant')
                        .send('email='+invitedEmail)
                        .send('password=Aa123456')
                        .expect(204);
                })
                .then(function(res){
                    assert(res.header['set-cookie']);
                });
    });

    it('invalid invitations should be rejected', function(){
        return request(init.servers.main)
                .post('/adminInvitation')
                .send('invitationId=invalidInvitation')
                .send('givenName=test')
                .send('surname=test')
                .send('password=Aa123456')
                .expect(400);
    });
});