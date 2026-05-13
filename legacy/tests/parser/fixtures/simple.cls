public class AccountService {
    public static Account getById(Id recordId) {
        return [SELECT Id, Name FROM Account WHERE Id = :recordId LIMIT 1];
    }
}
