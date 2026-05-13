trigger AccountTrigger on Account (after insert, after update) {
    for (Account a : Trigger.new) {
        System.debug(a.Id);
    }
}
