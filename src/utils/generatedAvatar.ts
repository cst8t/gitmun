const GENERATED_AVATAR_COLOUR_COUNT = 6;

export function generatedAvatarInitials(name: string): string {
  return name.split(" ").map(word => word[0]).join("").slice(0, 2).toUpperCase();
}

export function generatedAvatarColourIndex(name: string): number {
  let hash = 0;
  for (let index = 0; index < name.length; index++) {
    hash = name.charCodeAt(index) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % GENERATED_AVATAR_COLOUR_COUNT;
}
