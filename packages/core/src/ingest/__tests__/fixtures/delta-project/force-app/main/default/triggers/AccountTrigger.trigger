trigger AccountTrigger on Account (before update) {
  AccountService.save(Trigger.new);
  LegacyHelper.run();
}
