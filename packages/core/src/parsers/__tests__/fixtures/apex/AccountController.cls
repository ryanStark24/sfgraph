public with sharing class AccountController {
    @AuraEnabled(cacheable=true)
    public static Account getAccountById(Id accountId) {
        Account a = [SELECT Id, Name, Status__c FROM Account WHERE Id = :accountId LIMIT 1];
        return a;
    }

    @AuraEnabled
    public static void updateAccountStatus(Id accountId, String status) {
        Account a = new Account(Id = accountId, Status__c = status);
        update a;
    }

    @AuraEnabled
    public static String pingExternal() {
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:AcmeAPI/ping');
        return 'ok';
    }
}
