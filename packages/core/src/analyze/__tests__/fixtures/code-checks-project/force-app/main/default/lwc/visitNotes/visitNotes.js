import { LightningElement, api, wire } from 'lwc';
import { getRecord, getFieldValue } from 'lightning/uiRecordApi';
import NOTES_FIELD from '@salesforce/schema/Visit__c.Notes__c';

export default class VisitNotes extends LightningElement {
    @api recordId;

    @wire(getRecord, { recordId: '$recordId', fields: [NOTES_FIELD] })
    visit;

    get notes() {
        return getFieldValue(this.visit.data, NOTES_FIELD);
    }

    renderedCallback() {
        const container = this.template.querySelector('.notes-body');
        if (container && this.notes) {
            container.innerHTML = this.notes.replace(/\n/g, '<br>');
        }
    }
}
