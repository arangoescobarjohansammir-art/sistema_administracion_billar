export const tejoCourtsPerType = 6;
export const tejoProductValue = 4000;
export const tejoTypes = ['maxi', 'largo'] as const;
export type TejoType = typeof tejoTypes[number];

export function courtLabel(type: TejoType, number: number) {
  return (type === 'maxi' ? 'Maxitejo' : 'Tejo largo') + ' · cancha ' + number;
}
