// SPDX-FileCopyrightText: 2026 Stashley contributors
// SPDX-License-Identifier: AGPL-3.0-only

/** Countries of the demo participants with their weight, dialling code and name pools. */
export interface Country {
  code: string
  weight: number
  dial: string
  first: string[]
  last: string[]
}

export const countries: Country[] = [
  {
    code: 'DE',
    weight: 120,
    dial: '+49 151',
    first: [
      'Anna',
      'Lukas',
      'Petra',
      'Jonas',
      'Sabine',
      'Felix',
      'Ursula',
      'Matthias',
      'Lea',
      'Jürgen',
      'Katrin',
      'Tobias',
    ],
    last: [
      'Müller',
      'Schmidt',
      'Krüger',
      'Weber',
      'Wagner',
      'Becker',
      'Hoffmann',
      'Schäfer',
      'Koch',
      'Brandt',
      'Jensen',
      'Vogel',
    ],
  },
  {
    code: 'AT',
    weight: 30,
    dial: '+43 664',
    first: ['Elisabeth', 'Florian', 'Johanna', 'Stefan', 'Theresa', 'Markus'],
    last: ['Gruber', 'Huber', 'Bauer', 'Pichler', 'Moser', 'Steiner'],
  },
  {
    code: 'CH',
    weight: 25,
    dial: '+41 79',
    first: ['Reto', 'Corinne', 'Urs', 'Nadine', 'Beat', 'Simone'],
    last: ['Meier', 'Keller', 'Brunner', 'Frei', 'Zürcher', 'Baumann'],
  },
  {
    code: 'NL',
    weight: 25,
    dial: '+31 6',
    first: ['Daan', 'Sanne', 'Bram', 'Femke', 'Joost', 'Lotte'],
    last: ['de Jong', 'Jansen', 'van Dijk', 'Bakker', 'Visser', 'Smit'],
  },
  {
    code: 'BE',
    weight: 15,
    dial: '+32 470',
    first: ['Wout', 'Elise', 'Arne', 'Margot', 'Pieter', 'Ine'],
    last: ['Peeters', 'Maes', 'Claes', 'Goossens', 'Wouters', 'Dubois'],
  },
  {
    code: 'LU',
    weight: 8,
    dial: '+352 621',
    first: ['Gilles', 'Martine', 'Yves', 'Nathalie'],
    last: ['Schmit', 'Weber', 'Hoffmann', 'Kieffer'],
  },
  {
    code: 'FR',
    weight: 18,
    dial: '+33 6',
    first: ['Camille', 'Julien', 'Chloé', 'Antoine', 'Manon', 'Étienne'],
    last: ['Martin', 'Bernard', 'Lefèvre', 'Moreau', 'Laurent', 'Girard'],
  },
  {
    code: 'IT',
    weight: 14,
    dial: '+39 347',
    first: ['Giulia', 'Marco', 'Chiara', 'Luca', 'Francesca', 'Matteo'],
    last: ['Rossi', 'Russo', 'Ferrari', 'Esposito', 'Bianchi', 'Romano'],
  },
  {
    code: 'ES',
    weight: 10,
    dial: '+34 612',
    first: ['Lucía', 'Pablo', 'Carmen', 'Javier', 'Marta', 'Diego'],
    last: ['García', 'Fernández', 'López', 'Martínez', 'Sánchez', 'Ruiz'],
  },
  {
    code: 'PT',
    weight: 6,
    dial: '+351 912',
    first: ['Inês', 'João', 'Beatriz', 'Tiago'],
    last: ['Silva', 'Santos', 'Ferreira', 'Pereira'],
  },
  {
    code: 'PL',
    weight: 14,
    dial: '+48 501',
    first: ['Agnieszka', 'Piotr', 'Katarzyna', 'Tomasz', 'Magdalena', 'Paweł'],
    last: ['Nowak', 'Kowalski', 'Wiśniewski', 'Wójcik', 'Kamińska', 'Lewandowski'],
  },
  {
    code: 'CZ',
    weight: 10,
    dial: '+420 602',
    first: ['Jana', 'Jakub', 'Tereza', 'Ondřej', 'Lucie', 'Martin'],
    last: ['Novák', 'Svoboda', 'Dvořák', 'Černá', 'Procházka', 'Kučera'],
  },
  {
    code: 'DK',
    weight: 12,
    dial: '+45 20',
    first: ['Mette', 'Søren', 'Freja', 'Rasmus', 'Ida', 'Mads'],
    last: ['Nielsen', 'Hansen', 'Pedersen', 'Andersen', 'Christensen', 'Larsen'],
  },
  {
    code: 'SE',
    weight: 10,
    dial: '+46 70',
    first: ['Astrid', 'Erik', 'Elsa', 'Oskar', 'Maja', 'Anders'],
    last: ['Andersson', 'Johansson', 'Karlsson', 'Lindqvist', 'Berg', 'Nyström'],
  },
  {
    code: 'NO',
    weight: 6,
    dial: '+47 412',
    first: ['Ingrid', 'Henrik', 'Sigrid', 'Magnus'],
    last: ['Hansen', 'Johansen', 'Olsen', 'Haugen'],
  },
  {
    code: 'FI',
    weight: 6,
    dial: '+358 40',
    first: ['Aino', 'Mikko', 'Sanna', 'Juha'],
    last: ['Korhonen', 'Virtanen', 'Mäkinen', 'Nieminen'],
  },
  {
    code: 'GB',
    weight: 14,
    dial: '+44 7700',
    first: ['Olivia', 'Harry', 'Emily', 'George', 'Sophie', 'James'],
    last: ['Smith', 'Jones', 'Taylor', 'Brown', 'Wilson', 'Evans'],
  },
  {
    code: 'IE',
    weight: 6,
    dial: '+353 85',
    first: ['Aoife', 'Seán', 'Niamh', 'Ciarán'],
    last: ["O'Brien", 'Murphy', 'Kelly', "O'Sullivan"],
  },
  {
    code: 'US',
    weight: 10,
    dial: '+1 555',
    first: ['Emma', 'Michael', 'Ashley', 'Daniel', 'Megan', 'Ryan'],
    last: ['Johnson', 'Williams', 'Miller', 'Davis', 'Anderson', 'Thompson'],
  },
  {
    code: 'CA',
    weight: 6,
    dial: '+1 555',
    first: ['Chloe', 'Liam', 'Madison', 'Noah'],
    last: ['Tremblay', 'Roy', 'Gagnon', 'MacDonald'],
  },
  {
    code: 'JP',
    weight: 6,
    dial: '+81 90',
    first: ['Yuki', 'Haruto', 'Sakura', 'Ren'],
    last: ['Sato', 'Suzuki', 'Takahashi', 'Tanaka'],
  },
  {
    code: 'BR',
    weight: 5,
    dial: '+55 11',
    first: ['Ana', 'Rafael', 'Juliana', 'Gustavo'],
    last: ['Souza', 'Oliveira', 'Lima', 'Costa'],
  },
  {
    code: 'TR',
    weight: 8,
    dial: '+90 532',
    first: ['Aylin', 'Emre', 'Zeynep', 'Burak'],
    last: ['Demir', 'Yılmaz', 'Kaya', 'Şahin'],
  },
]

/** ASCII form of a name for email addresses. */
export function asciiName(name: string): string {
  return name
    .replaceAll('ß', 'ss')
    .replaceAll('ä', 'ae')
    .replaceAll('ö', 'oe')
    .replaceAll('ü', 'ue')
    .replaceAll('Ä', 'Ae')
    .replaceAll('Ö', 'Oe')
    .replaceAll('Ü', 'Ue')
    .replaceAll('ø', 'o')
    .replaceAll('ł', 'l')
    .replaceAll('ı', 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
}
