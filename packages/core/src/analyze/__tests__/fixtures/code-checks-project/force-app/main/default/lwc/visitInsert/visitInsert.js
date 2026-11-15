import { LightningElement, api } from 'lwc';

export default class VisitInsert extends LightningElement {
    @api heading;

    renderedCallback() {
        const el = this.template.querySelector('.slot');
        el.insertAdjacentHTML('beforeend', '<h2>' + this.heading + '</h2>');
    }
}
