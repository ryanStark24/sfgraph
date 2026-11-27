public with sharing class VisitTriggerHandler {

    // Positive: enqueueJob inside a for loop.
    public static void enqueuePerVisit(List<Visit__c> visits) {
        for (Visit__c v : visits) {
            System.enqueueJob(new VisitQueueable(v.Id));
        }
    }

    // Positive: email sent per record, batch started per record, event published in a while loop.
    public static void manyKinds(List<Visit__c> visits) {
        List<Messaging.SingleEmailMessage> mails = new List<Messaging.SingleEmailMessage>();
        for (Visit__c v : visits) {
            Messaging.sendEmail(mails, false);
            Database.executeBatch(new VisitBatch(v.Id), 100);
        }
        Integer i = 0;
        while (i < visits.size()) {
            EventBus.publish(new Visit_Event__e(Visit_Id__c = visits[i].Id));
            i++;
        }
    }

    // Positive: a call to an @future method, qualified and as a do-while body.
    public static void futureInLoop(List<Visit__c> visits) {
        for (Visit__c v : visits) {
            Notifier.notifyAsync(v.Id);
        }
    }

    // Positive: an unqualified call to this class's own @future method.
    @future
    public static void ownFuture(Id visitId) {
        System.debug(visitId);
    }

    public static void ownFutureInLoop(List<Visit__c> visits) {
        for (Visit__c v : visits) {
            ownFuture(v.Id);
        }
    }

    // Negative: the same calls after the loop, once.
    public static void bulkified(List<Visit__c> visits) {
        List<Id> ids = new List<Id>();
        List<Messaging.SingleEmailMessage> mails = new List<Messaging.SingleEmailMessage>();
        for (Visit__c v : visits) {
            ids.add(v.Id);
            mails.add(new Messaging.SingleEmailMessage());
        }
        System.enqueueJob(new VisitQueueable(ids));
        Messaging.sendEmail(mails, false);
        Database.executeBatch(new VisitBatch(ids[0]), 100);
        Notifier.notifyAsync(ids[0]);
    }

    // Negative: the words in a comment and in a string, a non-future call, a loop with no async.
    public static void notAsync(List<Visit__c> visits) {
        for (Visit__c v : visits) {
            // System.enqueueJob(new VisitQueueable(v.Id));
            String s = 'Messaging.sendEmail(mails, false)';
            Notifier.notifySync(v.Id);
            System.debug(s);
        }
    }
}
