import { type GatewayModel } from '@/lib/models'

export function ModelSelect({
  models,
  value,
  onValueChange,
}: {
  models: GatewayModel[]
  value: string
  onValueChange: (value: string) => void
}) {
  return (
    <select
      className="model-select"
      aria-label="Model"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {models.map((model) => (
        <option key={model.id} value={model.id}>
          {model.name}
        </option>
      ))}
    </select>
  )
}
