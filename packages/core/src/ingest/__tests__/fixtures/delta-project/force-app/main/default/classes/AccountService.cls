public with sharing class AccountService {
  @AuraEnabled public static List<Account> load(Set<Id> ids) {
    return [SELECT Id, Name, Tier__c FROM Account WHERE Id IN :ids];
  }
  public static void save(List<Account> accts) {
    update accts;
    OrderHelper.touch(accts);
  }
  public static void ping(String msg) {
    Util.log(msg);
  }
}
