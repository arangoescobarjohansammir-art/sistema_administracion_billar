export const tejoCourtsPerType = 6;
export const tejoProductValue = 4000;
export const tejoTypes = ['maxi', 'largo'] as const;
export type TejoType = typeof tejoTypes[number];
export const tejoTeams = ['A', 'B'] as const;
export type TejoTeam = typeof tejoTeams[number];

export function tejoPlayerTeam(number: number, teamSize: number): TejoTeam {
  return number <= teamSize ? 'A' : 'B';
}

export function tejoShare(total: number, members: number, index: number) {
  return Math.floor(total / members) + Number(index < total % members);
}

export function courtLabel(type: TejoType, number: number) {
  return (type === 'maxi' ? 'Maxitejo' : 'Tejo largo') + ' · cancha ' + number;
}
