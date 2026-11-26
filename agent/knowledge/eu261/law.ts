// Verbatim text of Regulation (EC) No 261/2004, OJ L 46, 17.2.2004
export const REGULATION_URL = "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32004R0261";

export const LAW = {
  "art3.1":
    "This Regulation shall apply: (a) to passengers departing from an airport located in the territory of a Member State to which the Treaty applies; (b) to passengers departing from an airport located in a third country to an airport situated in the territory of a Member State to which the Treaty applies, unless they received benefits or compensation and were given assistance in that third country, if the operating air carrier of the flight concerned is a Community carrier.",
  "art5.1c":
    "In case of cancellation of a flight, the passengers concerned shall: [...] (c) have the right to compensation by the operating air carrier in accordance with Article 7, unless: (i) they are informed of the cancellation at least two weeks before the scheduled time of departure; or (ii) they are informed of the cancellation between two weeks and seven days before the scheduled time of departure and are offered re-routing, allowing them to depart no more than two hours before the scheduled time of departure and to reach their final destination less than four hours after the scheduled time of arrival; or (iii) they are informed of the cancellation less than seven days before the scheduled time of departure and are offered re-routing, allowing them to depart no more than one hour before the scheduled time of departure and to reach their final destination less than two hours after the scheduled time of arrival.",
  "art5.3":
    "An operating air carrier shall not be obliged to pay compensation in accordance with Article 7, if it can prove that the cancellation is caused by extraordinary circumstances which could not have been avoided even if all reasonable measures had been taken.",
  "art5.4":
    "The burden of proof concerning the questions as to whether and when the passenger has been informed of the cancellation of the flight shall rest with the operating air carrier.",
  "art7.1":
    "Where reference is made to this Article, passengers shall receive compensation amounting to: (a) EUR 250 for all flights of 1500 kilometres or less; (b) EUR 400 for all intra-Community flights of more than 1500 kilometres, and for all other flights between 1500 and 3500 kilometres; (c) EUR 600 for all flights not falling under (a) or (b).",
  "art7.2":
    "When passengers are offered re-routing to their final destination on an alternative flight pursuant to Article 8, the arrival time of which does not exceed the scheduled arrival time of the flight originally booked (a) by two hours, in respect of all flights of 1500 kilometres or less; or (b) by three hours, in respect of all intra-Community flights of more than 1500 kilometres and for all other flights between 1500 and 3500 kilometres; or (c) by four hours, in respect of all flights not falling under (a) or (b), the operating air carrier may reduce the compensation provided for in paragraph 1 by 50 %.",
  "art7.3":
    "The compensation referred to in paragraph 1 shall be paid in cash, by electronic bank transfer, bank orders or bank cheques or, with the signed agreement of the passenger, in travel vouchers and/or other services.",
  "art7.4": "The distances given in paragraphs 1 and 2 shall be measured by the great circle route method.",
  "art8.1a":
    "reimbursement within seven days, by the means provided for in Article 7(3), of the full cost of the ticket at the price at which it was bought, for the part or parts of the journey not made, and for the part or parts already made if the flight is no longer serving any purpose in relation to the passenger's original travel plan",
  "art15.1":
    "Obligations vis-à-vis passengers pursuant to this Regulation may not be limited or waived, notably by a derogation or restrictive clause in the contract of carriage.",
  "art16.2":
    "Without prejudice to Article 12, each passenger may complain to any body designated under paragraph 1, or to any other competent body designated by a Member State, about an alleged infringement of this Regulation at any airport situated on the territory of a Member State or concerning any flight from a third country to an airport situated on that territory.",
  "recital14":
    "As under the Montreal Convention, obligations on operating air carriers should be limited or excluded in cases where an event has been caused by extraordinary circumstances which could not have been avoided even if all reasonable measures had been taken. Such circumstances may, in particular, occur in cases of political instability, meteorological conditions incompatible with the operation of the flight concerned, security risks, unexpected flight safety shortcomings and strikes that affect the operation of an operating air carrier.",
} as const;

export type LawRef = keyof typeof LAW;

export function isLawRef(value: string): value is LawRef {
  return Object.hasOwn(LAW, value);
}
