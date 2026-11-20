{{- define "kube-triage.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kube-triage.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "kube-triage.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "kube-triage.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "kube-triage.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "kube-triage.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
The ONLY permissions the API is ever granted. Read-only: get, list and watch, on a short list of
resources, and never Secrets. A test in the repository fails if a write verb or a wildcard appears here.
*/}}
{{- define "kube-triage.readOnlyRules" -}}
- apiGroups: [""]
  resources: ["pods", "events"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["apps"]
  resources: ["deployments", "replicasets"]
  verbs: ["get", "list", "watch"]
{{- if .Values.rbac.podLogs }}
- apiGroups: [""]
  resources: ["pods/log"]
  verbs: ["get"]
{{- end }}
{{- end -}}
