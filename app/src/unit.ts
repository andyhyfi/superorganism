// The unit shown beside amounts: USDC on chain, ENERGY in the play-money demo (placeholder word).
let current = 'USDC'
export const unit = () => current
export const setUnit = (u: string) => { current = u }
