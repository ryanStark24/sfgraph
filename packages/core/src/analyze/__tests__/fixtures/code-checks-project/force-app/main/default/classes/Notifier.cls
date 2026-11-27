public with sharing class Notifier {
    @future
    public static void notifyAsync(Id visitId) {
        System.debug(visitId);
    }

    public static void notifySync(Id visitId) {
        System.debug(visitId);
    }
}
