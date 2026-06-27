export interface LineConfig {
  lineId: string;
  name: string;
  color: string;
}

export const MELBOURNE_LINES: LineConfig[] = [
  { lineId: 'alamein',     name: 'Alamein',     color: '#094C8D' },
  { lineId: 'belgrave',    name: 'Belgrave',    color: '#094C8D' },
  { lineId: 'glen-waverley', name: 'Glen Waverley', color: '#094C8D' },
  { lineId: 'lilydale',    name: 'Lilydale',    color: '#094C8D' },
  { lineId: 'cranbourne',  name: 'Cranbourne',  color: '#16B4E8' },
  { lineId: 'pakenham',    name: 'Pakenham',    color: '#16B4E8' },
  { lineId: 'frankston',   name: 'Frankston',   color: '#159943' },
  { lineId: 'sandringham', name: 'Sandringham', color: '#FC7FAB' },
  { lineId: 'werribee',    name: 'Werribee',    color: '#74C365' },
  { lineId: 'williamstown', name: 'Williamstown', color: '#74C365' },
  { lineId: 'upfield',     name: 'Upfield',     color: '#FC7FAB' },
  { lineId: 'craigieburn', name: 'Craigieburn', color: '#FFBE00' },
  { lineId: 'sunbury',     name: 'Sunbury',     color: '#FFBE00' },
  { lineId: 'mernda',      name: 'Mernda',      color: '#E3000B' },
  { lineId: 'hurstbridge', name: 'Hurstbridge', color: '#E3000B' },
];

export const LINE_MAP = new Map(MELBOURNE_LINES.map(l => [l.lineId, l]));
