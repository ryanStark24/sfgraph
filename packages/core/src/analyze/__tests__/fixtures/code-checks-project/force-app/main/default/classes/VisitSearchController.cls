public with sharing class VisitSearchController {
    private static final String BASE = 'SELECT Id, Name FROM Visit__c';

    // Positive: the free-text term is concatenated into the query unescaped (status is escaped).
    @AuraEnabled(cacheable=true)
    public static List<Visit__c> search(String term, String status) {
        String safeStatus = String.escapeSingleQuotes(status == null ? '' : status);
        String soql = BASE + ' WHERE Status__c = \'' + safeStatus + '\'';
        if (String.isNotBlank(term)) {
            soql += ' AND Name LIKE \'%' + term + '%\'';
        }
        soql += ' LIMIT ' + VisitConstants.MAX_RESULTS;
        return Database.query(soql);
    }

    // Positive: concatenated directly in the call.
    @AuraEnabled
    public static Integer countByOwner(String owner) {
        return Database.countQuery('SELECT COUNT() FROM Visit__c WHERE OwnerId = \'' + owner + '\'');
    }

    // Positive: a parameter reassigned from another unescaped value, queryWithBinds with a built string.
    @AuraEnabled
    public static List<Visit__c> byRegion(String region) {
        String clause = region;
        String q = 'SELECT Id FROM Visit__c WHERE Region__c = \'' + clause + '\'';
        return Database.queryWithBinds(q, new Map<String, Object>(), AccessLevel.USER_MODE);
    }

    // Positive: SOSL through Search.query.
    @AuraEnabled
    public static List<List<SObject>> find(String text) {
        return Search.query('FIND \'' + text + '\' IN ALL FIELDS RETURNING Visit__c(Id)');
    }

    // Negative: the whole value is escaped inline.
    public static List<Visit__c> escapedInline(String term) {
        return Database.query('SELECT Id FROM Visit__c WHERE Name = \'' + String.escapeSingleQuotes(term) + '\'');
    }

    // Negative: escaped by reassigning the parameter first.
    public static List<Visit__c> escapedReassigned(String term) {
        term = String.escapeSingleQuotes(term);
        return Database.query('SELECT Id FROM Visit__c WHERE Name = \'' + term + '\'');
    }

    // Negative: a bind variable, not a concatenation.
    public static List<Visit__c> bound(String term) {
        return Database.query('SELECT Id FROM Visit__c WHERE Name = :term');
    }

    // Negative: a constant string and a static final constant.
    public static List<Visit__c> constants() {
        return Database.query(BASE + ' WHERE Status__c = \'' + VisitConstants.STATUS_OPEN + '\' LIMIT 10');
    }

    // Negative: names derived from Schema describe calls, a typed Integer and an Id.
    public static List<SObject> describeDerived(Integer lim, Id ownerId) {
        String objName = Visit__c.SObjectType.getDescribe().getName();
        String fieldName = Schema.SObjectType.Visit__c.fields.Name.getName();
        return Database.query('SELECT ' + fieldName + ' FROM ' + objName
            + ' WHERE OwnerId = \'' + ownerId + '\' LIMIT ' + lim);
    }

    // Negative: valueOf conversion and a Boolean.
    public static List<Visit__c> converted(Integer days, Boolean open) {
        String q = 'SELECT Id FROM Visit__c WHERE Age__c > ' + String.valueOf(days)
            + ' AND Open__c = ' + open;
        return Database.query(q);
    }
}
