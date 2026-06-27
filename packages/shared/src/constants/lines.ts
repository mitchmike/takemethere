export type LineRegion = 'Eastern' | 'South-Eastern' | 'Southern' | 'Northern' | 'North-Eastern' | 'Western';

export interface LineConfig {
  lineId: string;
  name: string;
  color: string;
  region: LineRegion;
}

export const REGION_ORDER: LineRegion[] = ['Eastern', 'South-Eastern', 'Southern', 'Northern', 'North-Eastern', 'Western'];

export const MELBOURNE_LINES: LineConfig[] = [
  { lineId: 'alamein',      name: 'Alamein',      color: '#094C8D', region: 'Eastern' },
  { lineId: 'belgrave',     name: 'Belgrave',     color: '#094C8D', region: 'Eastern' },
  { lineId: 'glen-waverley',name: 'Glen Waverley',color: '#094C8D', region: 'Eastern' },
  { lineId: 'lilydale',     name: 'Lilydale',     color: '#094C8D', region: 'Eastern' },
  { lineId: 'cranbourne',   name: 'Cranbourne',   color: '#16B4E8', region: 'South-Eastern' },
  { lineId: 'pakenham',     name: 'Pakenham',     color: '#16B4E8', region: 'South-Eastern' },
  { lineId: 'frankston',    name: 'Frankston',    color: '#159943', region: 'Southern' },
  { lineId: 'sandringham',  name: 'Sandringham',  color: '#FC7FAB', region: 'Southern' },
  { lineId: 'craigieburn',  name: 'Craigieburn',  color: '#FFBE00', region: 'Northern' },
  { lineId: 'sunbury',      name: 'Sunbury',      color: '#FFBE00', region: 'Northern' },
  { lineId: 'upfield',      name: 'Upfield',      color: '#FFBE00', region: 'Northern' },
  { lineId: 'mernda',       name: 'Mernda',       color: '#E3000B', region: 'North-Eastern' },
  { lineId: 'hurstbridge',  name: 'Hurstbridge',  color: '#E3000B', region: 'North-Eastern' },
  { lineId: 'werribee',     name: 'Werribee',     color: '#74C365', region: 'Western' },
  { lineId: 'williamstown', name: 'Williamstown', color: '#74C365', region: 'Western' },
];

export const LINE_MAP = new Map(MELBOURNE_LINES.map(l => [l.lineId, l]));
