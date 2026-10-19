import { LightningElement, wire } from 'lwc';
import load from '@salesforce/apex/AccountService.load';
import TIER from '@salesforce/schema/Account.Tier__c';
export default class AccountCard extends LightningElement { @wire(load) accts; tier = TIER; }
