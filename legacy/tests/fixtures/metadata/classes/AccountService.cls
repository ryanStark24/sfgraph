/**
 * AccountService — fixture class for Phase 3 ingestion tests.
 * Covers: SOQL, DML, cross-class call, label ref, EventBus.publish, picklist comparison.
 */
@SuppressWarnings('PMD')
public class AccountService {

    public static Account getById(Id recordId) {
        return [SELECT Id, Name, Status__c FROM Account WHERE Id = :recordId LIMIT 1];
    }

    public static void updateStatus(Id accountId, String newStatus) {
        Account acc = getById(accountId);
        if (acc.Status__c == 'Active') {
            String msg = System.Label.Account_Status_Label;
            acc.Status__c = newStatus;
            update acc;
            ContactService.notifyContacts(accountId);
            EventBus.publish(new Account_Updated__e(AccountId__c = accountId));
        }
    }

    public static List<Account> getAllAccounts() {
        List<Account> accounts = [SELECT Id, Name, Status__c FROM Account];
        insert new Task(Subject = 'Bulk processed');
        return accounts;
    }
}
