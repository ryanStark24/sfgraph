trigger VisitTrigger on Visit__c (after insert) {
    for (Visit__c v : Trigger.new) {
        System.enqueueJob(new VisitQueueable(v.Id));
    }
}
